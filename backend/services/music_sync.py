"""Selective music sync engine — rsync with gadget lifecycle management."""

import asyncio
import json
import logging
import tempfile
import time
from datetime import datetime, timezone

import aiosqlite

from backend.config import settings
from backend.services import script_runner
from backend.services import share_browser

logger = logging.getLogger(__name__)

# Active sync tracking
_active_sync: dict = {
    "job_id": None,
    "process": None,
    "cancelled": False,
}

MUSIC_MOUNT = "/mnt/music"
MUSIC_DEST = "/mnt/music/Music"
SHARE_MOUNT = "/mnt/music_share"
MUSIC_IMAGE = "/backingfiles/music_disk.bin"
GADGET_ENABLE = "/opt/teslapi/deploy/teslapi-gadget-enable.sh"
GADGET_DISABLE = "/opt/teslapi/deploy/teslapi-gadget-disable.sh"


async def start_sync(
    paths: list[str],
    mode: str,
    db_path: str,
) -> int:
    """Create a sync job and start the background sync task.

    Args:
        paths: List of paths to sync (artist dirs, album dirs, or individual files).
        mode: "selective" (sync listed paths) or "full" (sync everything).
        db_path: Path to SQLite database.

    Returns:
        Job ID.
    """
    if _active_sync["job_id"] is not None:
        raise RuntimeError("A sync is already in progress")

    async with aiosqlite.connect(db_path) as db:
        db.row_factory = aiosqlite.Row
        await db.execute("PRAGMA journal_mode=WAL")

        # Calculate total files and bytes for selected paths
        total_files = 0
        total_bytes = 0

        if mode == "selective" and paths:
            for path in paths:
                safe_path = path.rstrip("/") + "%"
                async with db.execute(
                    "SELECT COUNT(*) as cnt, COALESCE(SUM(size_bytes), 0) as sz FROM music_files WHERE path LIKE ?",
                    (safe_path,),
                ) as cursor:
                    row = await cursor.fetchone()
                    if row:
                        total_files += row["cnt"]
                        total_bytes += row["sz"]
        else:
            async with db.execute(
                "SELECT COUNT(*) as cnt, COALESCE(SUM(size_bytes), 0) as sz FROM music_files"
            ) as cursor:
                row = await cursor.fetchone()
                if row:
                    total_files = row["cnt"]
                    total_bytes = row["sz"]

        cursor = await db.execute(
            """INSERT INTO music_sync_jobs (status, mode, paths_json, files_total, bytes_total, started_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            ("pending", mode, json.dumps(paths), total_files, total_bytes,
             datetime.now(timezone.utc).isoformat()),
        )
        job_id = cursor.lastrowid
        await db.commit()

    _active_sync["job_id"] = job_id
    _active_sync["cancelled"] = False

    # Start background task
    asyncio.create_task(_run_sync(job_id, paths, mode, db_path))

    return job_id


async def _run_sync(job_id: int, paths: list[str], mode: str, db_path: str) -> None:
    """Background sync task with full gadget lifecycle."""
    try:
        await _update_job(db_path, job_id, status="running")

        if settings.dev_mode:
            await _run_sync_dev(job_id, paths, mode, db_path)
            return

        # Step 1: Disable USB gadget (can't detach individual LUNs while active)
        # This temporarily disconnects all USB drives from the Tesla.
        # The gadget will be re-enabled after sync completes.
        logger.info("Sync job %d: disabling USB gadget for music sync", job_id)
        result = await script_runner.run(
            "bash", [GADGET_DISABLE], timeout=15,
        )
        if result.returncode != 0:
            logger.warning("Gadget disable returned %d: %s (may already be disabled)", result.returncode, result.stderr)

        already_mounted_music = False
        try:
            # Step 2: Mount music disk image (skip if already mounted)
            check = await script_runner.run("mountpoint", ["-q", MUSIC_MOUNT], timeout=5)
            if check.returncode == 0:
                logger.info("Sync job %d: music image already mounted", job_id)
                already_mounted_music = True
            else:
                logger.info("Sync job %d: mounting music disk image", job_id)
                result = await script_runner.run(
                    "mount", ["-o", "loop", MUSIC_IMAGE, MUSIC_MOUNT], timeout=15,
                )
                if result.returncode != 0:
                    raise RuntimeError(f"Failed to mount music image: {result.stderr}")

            # Ensure /Music/ subdirectory exists
            result = await script_runner.run(
                "mkdir", ["-p", MUSIC_DEST], timeout=5,
            )

            try:
                # Step 3: Mount source music share if not already mounted
                if not await share_browser.is_mounted(SHARE_MOUNT):
                    logger.info("Sync job %d: mounting music source share", job_id)
                    share_config = share_browser.get_music_share_config()
                    if not share_config:
                        raise RuntimeError("Music share not configured. Set it up in Settings > Network Shares.")
                    import os
                    os.makedirs(SHARE_MOUNT, exist_ok=True)
                    mounted = await share_browser.mount_share(
                        share_type=share_config.get("share_type", share_config.get("type", "cifs")),
                        server=share_config.get("server", ""),
                        path=share_config.get("share_name", share_config.get("path", "")),
                        mountpoint=SHARE_MOUNT,
                        username=share_config.get("username", ""),
                        password=share_config.get("password", ""),
                        domain=share_config.get("domain", ""),
                    )
                    if not mounted:
                        raise RuntimeError("Failed to mount music source share")

                if _active_sync["cancelled"]:
                    raise asyncio.CancelledError()

                if mode == "full":
                    # Full sync: rsync entire share without --files-from
                    # This copies EVERYTHING, not just indexed files
                    logger.info("Sync job %d: full sync — rsyncing entire share", job_id)
                    await _run_rsync_full(job_id, db_path)
                else:
                    # Selective sync: build file list from DB or filesystem
                    file_list = await _build_file_list(paths, mode, db_path)

                    if not file_list:
                        logger.info("Sync job %d: no files to sync", job_id)
                        await _update_job(db_path, job_id, status="completed")
                        return

                    with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False) as f:
                        for path in file_list:
                            f.write(path.lstrip("/") + "\n")
                        files_from = f.name

                    try:
                        await _run_rsync(job_id, files_from, db_path)
                    finally:
                        import os
                        os.unlink(files_from)

                # Step 6: Mark synced files in DB
                async with aiosqlite.connect(db_path) as db:
                    for path in file_list:
                        await db.execute(
                            "UPDATE music_files SET synced = 1 WHERE path = ?",
                            (path,),
                        )
                    await db.commit()

                await _update_job(db_path, job_id, status="completed")

            finally:
                # Step 7: Unmount music source share and music image
                logger.info("Sync job %d: unmounting", job_id)
                await share_browser.unmount_share(SHARE_MOUNT)
                if not already_mounted_music:
                    await script_runner.run("umount", [MUSIC_MOUNT], timeout=15)

        finally:
            # Step 8: Re-enable USB gadget (re-presents all drives to Tesla)
            logger.info("Sync job %d: re-enabling USB gadget", job_id)
            await script_runner.run(
                "bash", [GADGET_ENABLE], timeout=15,
            )

    except asyncio.CancelledError:
        logger.info("Sync job %d: cancelled", job_id)
        await _update_job(db_path, job_id, status="cancelled")
    except Exception as exc:
        logger.error("Sync job %d failed: %s", job_id, exc)
        await _update_job(db_path, job_id, status="failed", error=str(exc))
    finally:
        _active_sync["job_id"] = None
        _active_sync["process"] = None
        _active_sync["cancelled"] = False


async def _run_sync_dev(job_id: int, paths: list[str], mode: str, db_path: str) -> None:
    """Simulate sync with progress updates in dev mode."""
    async with aiosqlite.connect(db_path) as db:
        db.row_factory = aiosqlite.Row

        # Get total files for the paths
        total_files = 0
        total_bytes = 0

        if mode == "selective" and paths:
            for path in paths:
                safe_path = path.rstrip("/") + "%"
                async with db.execute(
                    "SELECT COUNT(*) as cnt, COALESCE(SUM(size_bytes), 0) as sz FROM music_files WHERE path LIKE ?",
                    (safe_path,),
                ) as cursor:
                    row = await cursor.fetchone()
                    if row:
                        total_files += row["cnt"]
                        total_bytes += row["sz"]
        else:
            async with db.execute(
                "SELECT COUNT(*) as cnt, COALESCE(SUM(size_bytes), 0) as sz FROM music_files"
            ) as cursor:
                row = await cursor.fetchone()
                if row:
                    total_files = row["cnt"]
                    total_bytes = row["sz"]

        if total_files == 0:
            total_files = 150
            total_bytes = 5_000_000_000

    # Simulate progress
    copied_files = 0
    copied_bytes = 0
    bytes_per_step = total_bytes // max(total_files, 1)

    for i in range(total_files):
        if _active_sync["cancelled"]:
            await _update_job(db_path, job_id, status="cancelled")
            _active_sync["job_id"] = None
            return

        copied_files += 1
        copied_bytes += bytes_per_step

        if i % 5 == 0 or i == total_files - 1:
            await _update_job(
                db_path, job_id,
                files_copied=copied_files,
                bytes_copied=min(copied_bytes, total_bytes),
            )

        await asyncio.sleep(0.1)

    await _update_job(
        db_path, job_id,
        status="completed",
        files_copied=total_files,
        bytes_copied=total_bytes,
    )
    _active_sync["job_id"] = None


async def _build_file_list(paths: list[str], mode: str, db_path: str) -> list[str]:
    """Build list of file paths to sync.

    First tries the indexed DB. If empty (library not indexed yet),
    falls back to scanning the mounted share directly.
    """
    import os

    # Try DB first
    async with aiosqlite.connect(db_path) as db:
        db.row_factory = aiosqlite.Row

        file_list = []
        if mode == "selective" and paths:
            for path in paths:
                safe_path = path.rstrip("/") + "%"
                async with db.execute(
                    "SELECT path FROM music_files WHERE path LIKE ?",
                    (safe_path,),
                ) as cursor:
                    async for row in cursor:
                        file_list.append(row["path"])
        else:
            async with db.execute("SELECT path FROM music_files") as cursor:
                async for row in cursor:
                    file_list.append(row["path"])

    # If DB is empty, scan the filesystem directly
    if not file_list and mode == "selective" and paths:
        logger.info("Music index empty, scanning share directly for %d paths", len(paths))
        for rel_path in paths:
            full_path = os.path.join(SHARE_MOUNT, rel_path)
            if os.path.isdir(full_path):
                for root, _dirs, files in os.walk(full_path):
                    for f in files:
                        abs_path = os.path.join(root, f)
                        # Store as relative to share mount
                        file_list.append(os.path.relpath(abs_path, SHARE_MOUNT))
            elif os.path.isfile(full_path):
                file_list.append(rel_path)

    return file_list


async def _run_rsync_full(job_id: int, db_path: str) -> None:
    """Run a full rsync of the entire share — no --files-from, no index dependency."""
    # Safety check: verify both mounts are actually in place
    import os
    check_music = await script_runner.run("mountpoint", ["-q", MUSIC_MOUNT], timeout=5)
    check_share = await script_runner.run("mountpoint", ["-q", SHARE_MOUNT], timeout=5)
    if check_music.returncode != 0:
        raise RuntimeError(f"Music image not mounted at {MUSIC_MOUNT} — cannot sync")
    if check_share.returncode != 0:
        raise RuntimeError(f"Music share not mounted at {SHARE_MOUNT} — cannot sync")

    # Ensure /Music/ subdir exists
    os.makedirs(MUSIC_DEST, exist_ok=True)

    cmd = [
        "rsync",
        "-a",
        "--timeout=300",
        f"{SHARE_MOUNT}/",
        f"{MUSIC_DEST}/",
    ]

    logger.info("Sync job %d: starting full rsync: %s", job_id, " ".join(cmd))

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _active_sync["process"] = proc

    # For full sync, we can't easily track file-by-file progress.
    # Just wait for completion and check periodically.
    stdout, stderr = await proc.communicate()

    if proc.returncode not in (0, 23, 24):
        logger.error("Sync job %d: full rsync failed (code %d): %s",
                     job_id, proc.returncode, stderr.decode()[:500])
        await _update_job(db_path, job_id,
                          status="failed",
                          error_message=f"rsync exit code {proc.returncode}: {stderr.decode()[:200]}")
        return

    logger.info("Sync job %d: full rsync completed (code %d)", job_id, proc.returncode)
    await _update_job(db_path, job_id, status="completed")


async def _run_rsync(job_id: int, files_from: str, db_path: str) -> None:
    """Run rsync and parse progress output."""
    cmd = [
        "rsync",
        "-av",
        "--progress",
        f"--files-from={files_from}",
        f"{SHARE_MOUNT}/",
        f"{MUSIC_DEST}/",
    ]

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _active_sync["process"] = proc

    files_copied = 0
    bytes_copied = 0

    async for line in proc.stdout:
        if _active_sync["cancelled"]:
            proc.kill()
            await proc.wait()
            raise asyncio.CancelledError()

        text = line.decode("utf-8", errors="replace").strip()

        # Parse rsync progress lines:
        # "    1,234,567 100%  123.45MB/s    0:00:01 (xfr#1, to-chk=99/100)"
        if "xfr#" in text:
            files_copied += 1
            # Extract bytes from the beginning of the line
            parts = text.split()
            if parts:
                try:
                    bytes_str = parts[0].replace(",", "")
                    bytes_copied += int(bytes_str)
                except (ValueError, IndexError):
                    pass

            if files_copied % 10 == 0:
                await _update_job(
                    db_path, job_id,
                    files_copied=files_copied,
                    bytes_copied=bytes_copied,
                )

    await proc.wait()

    if proc.returncode not in (0, 23):  # 23 = partial transfer (some files vanished)
        stderr = await proc.stderr.read()
        raise RuntimeError(f"rsync failed (exit {proc.returncode}): {stderr.decode()}")

    await _update_job(
        db_path, job_id,
        files_copied=files_copied,
        bytes_copied=bytes_copied,
    )


async def get_sync_status(db_path: str, job_id: int | None = None) -> dict | None:
    """Get current/latest sync job status."""
    async with aiosqlite.connect(db_path) as db:
        db.row_factory = aiosqlite.Row
        await db.execute("PRAGMA journal_mode=WAL")

        if job_id:
            query = "SELECT * FROM music_sync_jobs WHERE id = ?"
            params = (job_id,)
        else:
            query = "SELECT * FROM music_sync_jobs ORDER BY id DESC LIMIT 1"
            params = ()

        async with db.execute(query, params) as cursor:
            row = await cursor.fetchone()
            if row:
                return dict(row)

    return None


async def get_sync_history(db_path: str, limit: int = 20) -> list[dict]:
    """Get past sync jobs."""
    async with aiosqlite.connect(db_path) as db:
        db.row_factory = aiosqlite.Row
        await db.execute("PRAGMA journal_mode=WAL")

        jobs = []
        async with db.execute(
            "SELECT * FROM music_sync_jobs ORDER BY id DESC LIMIT ?",
            (limit,),
        ) as cursor:
            async for row in cursor:
                jobs.append(dict(row))

    return jobs


async def cancel_sync(db_path: str) -> bool:
    """Cancel the currently running sync."""
    if _active_sync["job_id"] is None:
        return False

    _active_sync["cancelled"] = True

    # Kill rsync process if running
    proc = _active_sync.get("process")
    if proc and proc.returncode is None:
        try:
            proc.kill()
            await proc.wait()
        except (ProcessLookupError, OSError):
            pass

    return True


async def _update_job(db_path: str, job_id: int, **kwargs) -> None:
    """Update sync job fields in database."""
    if not kwargs:
        return

    set_clauses = []
    values = []

    for key, val in kwargs.items():
        if key == "error":
            set_clauses.append("error_message = ?")
            values.append(val)
        elif key == "status":
            set_clauses.append("status = ?")
            values.append(val)
            if val in ("completed", "failed", "cancelled"):
                set_clauses.append("completed_at = ?")
                values.append(datetime.now(timezone.utc).isoformat())
        else:
            set_clauses.append(f"{key} = ?")
            values.append(val)

    values.append(job_id)

    async with aiosqlite.connect(db_path) as db:
        await db.execute("PRAGMA journal_mode=WAL")
        await db.execute(
            f"UPDATE music_sync_jobs SET {', '.join(set_clauses)} WHERE id = ?",
            values,
        )
        await db.commit()
