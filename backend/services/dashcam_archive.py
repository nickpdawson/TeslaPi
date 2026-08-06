"""Dashcam archive service — rsync clips to network share with DB tracking."""

import asyncio
import logging
import os
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

import aiosqlite

from backend.config import settings
from backend.services import script_runner
from backend.services import share_browser

logger = logging.getLogger(__name__)

# Active archive tracking
_active_archive: dict = {
    "job_id": None,
    "process": None,
    "cancelled": False,
}

CAM_IMAGE = "/backingfiles/cam_disk.bin"
CAM_MOUNT = "/mnt/cam"
ARCHIVE_MOUNT = "/mnt/archive"
ARCHIVE_DIRS = ("SavedClips", "SentryClips")


def _get_archive_share_config() -> dict | None:
    """Read archive share config from teslausb_setup_variables.conf.

    Looks for ARCHIVE_SERVER/archive_share_server, SHARE_NAME/archive_share_path, etc.
    Returns dict with: server, share_name, username, password, domain.
    """
    from backend.services.config_manager import read_config

    cfg = read_config()
    if not cfg:
        return None

    server = cfg.get("archive_share_server") or cfg.get("ARCHIVE_SERVER", "")
    share_name = cfg.get("archive_share_path") or cfg.get("SHARE_NAME", "")
    share_type = cfg.get("archive_share_type") or cfg.get("SHARE_TYPE", "cifs")
    username = cfg.get("archive_share_username") or cfg.get("SHARE_USER", "")
    password = cfg.get("archive_share_password") or cfg.get("SHARE_PASSWORD", "")
    domain = cfg.get("archive_share_domain") or cfg.get("SHARE_DOMAIN", "")

    if not server or not share_name:
        return None

    return {
        "server": server,
        "share_name": share_name,
        "share_type": (share_type or "cifs").lower(),
        "username": username,
        "password": password,
        "domain": domain,
    }


async def start_archive(
    trigger: str = "manual",
    delete_after: bool = False,
) -> int:
    """Create an archive job and start the background archive task.

    Args:
        trigger: "manual" or "auto".
        delete_after: If True, delete clips from cam after successful archive.

    Returns:
        Job ID.
    """
    if _active_archive["job_id"] is not None:
        raise RuntimeError("An archive is already in progress")

    # NOTE: the inherited teslausb archiveloop daemon (enabled by default — see
    # teslapi_plan.md "the archive loop is preserved") is the canonical dashcam
    # archiver and also touches the cam image + USB gadget. This web-triggered
    # archiver coexists with it; the *_we_mounted tracking below avoids tearing down
    # the daemon's mounts, but full coordination (or deciding which archiver owns
    # dashcam) is an unresolved Phase 2/3 architectural decision — see work log.

    # Claim the slot synchronously BEFORE the first await so two concurrent callers
    # can't both pass the guard above and start two archives into one image.
    _active_archive["job_id"] = -1  # sentinel: claimed, real id assigned below
    _active_archive["cancelled"] = False
    _active_archive["process"] = None

    db_path = str(settings.database_path)
    try:
        async with aiosqlite.connect(db_path) as db:
            db.row_factory = aiosqlite.Row
            await db.execute("PRAGMA journal_mode=WAL")

            cursor = await db.execute(
                """INSERT INTO dashcam_archive_jobs (status, trigger, started_at)
                   VALUES (?, ?, ?)""",
                ("pending", trigger, datetime.now(timezone.utc).isoformat()),
            )
            job_id = cursor.lastrowid
            await db.commit()
    except Exception:
        _active_archive["job_id"] = None  # release the claim on failure
        raise

    _active_archive["job_id"] = job_id

    asyncio.create_task(_run_archive(job_id, delete_after))
    return job_id


async def _archive_one_clip(src: str, dest_dir: str, timeout: float = 300.0) -> tuple[int, str]:
    """rsync a single clip, tracked as ``_active_archive['process']`` so cancel can
    kill it mid-transfer. Returns ``(returncode, stderr)``. rc 124 = timed out."""
    # -rt (recursive + mtimes), NOT -a: archiving to a network share (esp. NFS with
    # root_squash) rejects the chown/chmod that -a's -o/-g/-p attempt, making rsync
    # return code 23 for every clip even though the data copied fine. Clips are plain
    # files that need only content + mtime preserved.
    proc = await asyncio.create_subprocess_exec(
        "rsync", "-rt", "--partial", "--timeout=60", src, dest_dir + "/",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _active_archive["process"] = proc
    try:
        try:
            _, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            await proc.wait()
            return 124, "rsync timed out"
        return proc.returncode, (stderr.decode("utf-8", errors="replace") if stderr else "")
    finally:
        _active_archive["process"] = None


async def _run_archive(job_id: int, delete_after: bool) -> None:
    """Background archive task with full mount lifecycle."""
    db_path = str(settings.database_path)
    try:
        await _update_job(db_path, job_id, status="running")

        if settings.dev_mode:
            await _run_archive_dev(job_id, db_path)
            return

        if delete_after:
            # The cam image is mounted read-only (so recording continues safely), so
            # host-side deletion cannot and MUST not happen here — writing the image
            # while the car owns it corrupts the filesystem. Free-space management on
            # the cam is a separate mechanism; skip deletion and say so.
            logger.warning(
                "Archive job %d: delete_after requested but unsupported with the "
                "read-only cam snapshot; clips will be archived but NOT deleted.",
                job_id,
            )

        # Step 1: Mount cam image read-only. Read-only means the host never writes the
        # image, so it is safe to snapshot while the Tesla records through the gadget.
        # Skip if already mounted — that mount may belong to the inherited teslausb
        # archiveloop daemon, and we must NOT unmount someone else's mount (Step 7).
        cam_we_mounted = False
        cam_check = await script_runner.run("mountpoint", ["-q", CAM_MOUNT], timeout=5)
        if cam_check.returncode == 0:
            logger.info("Archive job %d: cam image already mounted (reusing, will not unmount)", job_id)
        else:
            logger.info("Archive job %d: mounting cam image read-only", job_id)
            result = await script_runner.run(
                "mount", ["-o", "ro,loop", CAM_IMAGE, CAM_MOUNT], timeout=15,
            )
            if result.returncode != 0:
                raise RuntimeError(f"Failed to mount cam image: {result.stderr}")
            cam_we_mounted = True

        try:
            # Step 2: Discover unarchived clips
            unarchived = await _discover_unarchived(db_path)

            if not unarchived:
                logger.info("Archive job %d: no new clips to archive", job_id)
                await _update_job(db_path, job_id, status="completed",
                                  clips_total=0, bytes_total=0)
                return

            total_bytes = sum(c["size_bytes"] for c in unarchived)
            await _update_job(db_path, job_id,
                              clips_total=len(unarchived),
                              bytes_total=total_bytes)

            # Step 3: Mount archive share RW — skip if already mounted (that mount may
            # belong to the teslausb archiveloop daemon; we must not unmount it later).
            archive_we_mounted = False
            if await share_browser.is_mounted(ARCHIVE_MOUNT):
                logger.info("Archive job %d: archive share already mounted (reusing, will not unmount)", job_id)
            else:
                share_cfg = _get_archive_share_config()
                if not share_cfg:
                    raise RuntimeError("Archive share not configured")

                logger.info("Archive job %d: mounting archive share (%s) on %s",
                            job_id, share_cfg["share_type"], share_cfg["server"])
                mounted = await share_browser.mount_share(
                    share_type=share_cfg["share_type"],
                    server=share_cfg["server"],
                    path=share_cfg["share_name"],
                    mountpoint=ARCHIVE_MOUNT,
                    username=share_cfg["username"],
                    password=share_cfg["password"],
                    domain=share_cfg["domain"],
                    read_only=False,
                )
                if not mounted:
                    raise RuntimeError("Failed to mount archive share")
                archive_we_mounted = True

            try:
                # Step 4: Ensure destination directories exist
                for d in ARCHIVE_DIRS:
                    dest = os.path.join(ARCHIVE_MOUNT, "TeslaCam", d)
                    os.makedirs(dest, exist_ok=True)

                # Step 5: rsync each clip. Only a clean rsync (rc 0) counts as archived
                # and is recorded in the DB; anything else (partial 23, error, timeout)
                # is a failure to retry next run — never recorded, never deleted.
                clips_copied = 0
                bytes_copied = 0
                clips_deleted = 0
                clips_failed = 0

                for clip in unarchived:
                    if _active_archive["cancelled"]:
                        raise asyncio.CancelledError()

                    src = os.path.join(
                        CAM_MOUNT, "TeslaCam", clip["event_type"],
                        clip["event_dir"], clip["clip_file"],
                    )
                    # Archive to root of share: /SavedClips/{event_dir}/
                    # (matches existing teslausb archive structure)
                    dest_dir = os.path.join(
                        ARCHIVE_MOUNT, clip["event_type"],
                        clip["event_dir"],
                    )
                    os.makedirs(dest_dir, exist_ok=True)

                    rc, stderr = await _archive_one_clip(src, dest_dir)

                    # A cancel that killed rsync surfaces as a non-zero rc here.
                    if _active_archive["cancelled"]:
                        raise asyncio.CancelledError()

                    if rc != 0:
                        # rc 23 (partial), other errors, or 124 (timeout) — not verified.
                        clips_failed += 1
                        logger.warning(
                            "Archive job %d: clip %s not archived (rsync rc %s): %s",
                            job_id, clip["clip_file"], rc, stderr[:200],
                        )
                        continue

                    clips_copied += 1
                    bytes_copied += clip["size_bytes"]

                    # Record in DB (only verified copies)
                    async with aiosqlite.connect(db_path) as db:
                        await db.execute("PRAGMA journal_mode=WAL")
                        await db.execute(
                            """INSERT OR IGNORE INTO dashcam_archived_clips
                               (event_type, event_dir, clip_file, size_bytes, archive_job_id)
                               VALUES (?, ?, ?, ?, ?)""",
                            (clip["event_type"], clip["event_dir"],
                             clip["clip_file"], clip["size_bytes"], job_id),
                        )
                        await db.commit()

                    # Deletion from the cam is intentionally NOT done here — the cam is
                    # mounted read-only and deleting from a live cam image is unsafe.
                    # (delete_after was already warned about above.)

                    # Update progress periodically
                    if clips_copied % 5 == 0 or clips_copied == len(unarchived):
                        await _update_job(
                            db_path, job_id,
                            clips_copied=clips_copied,
                            bytes_copied=bytes_copied,
                            clips_deleted=clips_deleted,
                        )

                # Report honestly: if any clip failed, this is a partial archive, not a
                # clean success — the failed clips are still on the cam for next run.
                if clips_failed > 0:
                    await _update_job(
                        db_path, job_id,
                        status="partial",
                        clips_copied=clips_copied,
                        bytes_copied=bytes_copied,
                        clips_deleted=clips_deleted,
                        error_message=f"{clips_failed} of {len(unarchived)} clips could not be archived; they will retry on the next run.",
                    )
                else:
                    await _update_job(
                        db_path, job_id,
                        status="completed",
                        clips_copied=clips_copied,
                        bytes_copied=bytes_copied,
                        clips_deleted=clips_deleted,
                    )

            finally:
                # Step 6: Unmount the archive share — ONLY if we mounted it, so we
                # don't tear down a mount the teslausb daemon may be using.
                if archive_we_mounted:
                    logger.info("Archive job %d: unmounting archive share", job_id)
                    await share_browser.unmount_share(ARCHIVE_MOUNT)
                else:
                    logger.info("Archive job %d: leaving pre-existing archive mount in place", job_id)

        finally:
            # Step 7: Unmount the cam image — ONLY if we mounted it. A pre-existing
            # mount may belong to the teslausb archiveloop daemon; unmounting it would
            # disrupt the daemon mid-archive.
            if cam_we_mounted:
                logger.info("Archive job %d: unmounting cam image", job_id)
                await script_runner.run("umount", [CAM_MOUNT], timeout=15)
            else:
                logger.info("Archive job %d: leaving pre-existing cam mount in place", job_id)

    except asyncio.CancelledError:
        logger.info("Archive job %d: cancelled", job_id)
        await _update_job(db_path, job_id, status="cancelled")
    except Exception as exc:
        logger.error("Archive job %d failed: %s", job_id, exc)
        await _update_job(db_path, job_id, status="failed", error=str(exc))
    finally:
        _active_archive["job_id"] = None
        _active_archive["process"] = None
        _active_archive["cancelled"] = False


async def _run_archive_dev(job_id: int, db_path: str) -> None:
    """Simulate archive with progress updates in dev mode."""
    total_clips = 47
    total_bytes = 13_207_024_640
    bytes_per_clip = total_bytes // total_clips

    await _update_job(db_path, job_id, clips_total=total_clips, bytes_total=total_bytes)

    clips_copied = 0
    bytes_copied = 0

    for i in range(total_clips):
        if _active_archive["cancelled"]:
            await _update_job(db_path, job_id, status="cancelled")
            _active_archive["job_id"] = None
            return

        clips_copied += 1
        bytes_copied += bytes_per_clip

        if i % 5 == 0 or i == total_clips - 1:
            await _update_job(
                db_path, job_id,
                clips_copied=clips_copied,
                bytes_copied=min(bytes_copied, total_bytes),
            )

        await asyncio.sleep(0.15)

    await _update_job(
        db_path, job_id,
        status="completed",
        clips_copied=total_clips,
        bytes_copied=total_bytes,
    )
    _active_archive["job_id"] = None


async def _discover_unarchived(db_path: str) -> list[dict]:
    """Scan cam dirs and check DB for already archived clips.

    Only looks at SavedClips/ and SentryClips/ (NOT RecentClips).
    Returns list of dicts with: event_type, event_dir, clip_file, size_bytes.
    """
    unarchived = []

    for event_type in ARCHIVE_DIRS:
        base = os.path.join(CAM_MOUNT, "TeslaCam", event_type)
        if not os.path.isdir(base):
            continue

        for event_dir in os.listdir(base):
            event_path = os.path.join(base, event_dir)
            if not os.path.isdir(event_path):
                continue

            for clip_file in os.listdir(event_path):
                clip_path = os.path.join(event_path, clip_file)
                if not os.path.isfile(clip_path):
                    continue

                # Check if already archived
                async with aiosqlite.connect(db_path) as db:
                    db.row_factory = aiosqlite.Row
                    await db.execute("PRAGMA journal_mode=WAL")
                    async with db.execute(
                        """SELECT id FROM dashcam_archived_clips
                           WHERE event_type = ? AND event_dir = ? AND clip_file = ?""",
                        (event_type, event_dir, clip_file),
                    ) as cursor:
                        if await cursor.fetchone():
                            continue

                try:
                    size = os.path.getsize(clip_path)
                except OSError:
                    size = 0

                unarchived.append({
                    "event_type": event_type,
                    "event_dir": event_dir,
                    "clip_file": clip_file,
                    "size_bytes": size,
                })

    return unarchived


async def get_archive_status() -> dict:
    """Get latest job info plus aggregate stats.

    Returns dict with: latest_job, total_clips, total_bytes, server_name, server_reachable.
    """
    db_path = str(settings.database_path)
    result = {
        "latest_job": None,
        "total_clips": 0,
        "total_bytes": 0,
        "server_name": "",
        "server_reachable": False,
    }

    # Get archive server name from config
    share_cfg = _get_archive_share_config()
    if share_cfg:
        result["server_name"] = share_cfg["server"]

        # Quick reachability check (ping with 1s timeout)
        if not settings.dev_mode:
            ping = await script_runner.run(
                "ping", ["-c", "1", "-W", "1", share_cfg["server"]], timeout=5,
            )
            result["server_reachable"] = ping.returncode == 0
        else:
            result["server_reachable"] = True

    async with aiosqlite.connect(db_path) as db:
        db.row_factory = aiosqlite.Row
        await db.execute("PRAGMA journal_mode=WAL")

        # Latest job
        async with db.execute(
            "SELECT * FROM dashcam_archive_jobs ORDER BY id DESC LIMIT 1"
        ) as cursor:
            row = await cursor.fetchone()
            if row:
                result["latest_job"] = dict(row)

        # Aggregate stats
        async with db.execute(
            "SELECT COUNT(*) as cnt, COALESCE(SUM(size_bytes), 0) as sz FROM dashcam_archived_clips"
        ) as cursor:
            row = await cursor.fetchone()
            if row:
                result["total_clips"] = row["cnt"]
                result["total_bytes"] = row["sz"]

    return result


async def get_archive_history(limit: int = 20) -> list[dict]:
    """Get past archive jobs."""
    db_path = str(settings.database_path)
    async with aiosqlite.connect(db_path) as db:
        db.row_factory = aiosqlite.Row
        await db.execute("PRAGMA journal_mode=WAL")

        jobs = []
        async with db.execute(
            "SELECT * FROM dashcam_archive_jobs ORDER BY id DESC LIMIT ?",
            (limit,),
        ) as cursor:
            async for row in cursor:
                jobs.append(dict(row))

    return jobs


async def get_archived_clips(
    event_type: str | None = None,
    offset: int = 0,
    limit: int = 50,
) -> dict:
    """Get archived clips with optional filtering and pagination."""
    db_path = str(settings.database_path)
    async with aiosqlite.connect(db_path) as db:
        db.row_factory = aiosqlite.Row
        await db.execute("PRAGMA journal_mode=WAL")

        where = ""
        params: list = []
        if event_type:
            where = "WHERE event_type = ?"
            params.append(event_type)

        # Count
        async with db.execute(
            f"SELECT COUNT(*) as cnt FROM dashcam_archived_clips {where}",
            params,
        ) as cursor:
            row = await cursor.fetchone()
            total = row["cnt"] if row else 0

        # Paginated results
        query = f"""SELECT * FROM dashcam_archived_clips {where}
                    ORDER BY archived_at DESC LIMIT ? OFFSET ?"""
        params.extend([limit, offset])
        clips = []
        async with db.execute(query, params) as cursor:
            async for row in cursor:
                clips.append(dict(row))

    return {
        "clips": clips,
        "total": total,
        "offset": offset,
        "limit": limit,
        "hasMore": offset + limit < total,
    }


async def cancel_archive() -> bool:
    """Cancel the currently running archive."""
    if _active_archive["job_id"] is None:
        return False

    _active_archive["cancelled"] = True

    proc = _active_archive.get("process")
    if proc and proc.returncode is None:
        try:
            proc.kill()
            await proc.wait()
        except (ProcessLookupError, OSError):
            pass

    return True


async def _update_job(db_path: str, job_id: int, **kwargs) -> None:
    """Update archive job fields in database."""
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
            if val in ("completed", "failed", "cancelled", "partial"):
                set_clauses.append("completed_at = ?")
                values.append(datetime.now(timezone.utc).isoformat())
        else:
            set_clauses.append(f"{key} = ?")
            values.append(val)

    values.append(job_id)

    async with aiosqlite.connect(db_path) as db:
        await db.execute("PRAGMA journal_mode=WAL")
        await db.execute(
            f"UPDATE dashcam_archive_jobs SET {', '.join(set_clauses)} WHERE id = ?",
            values,
        )
        await db.commit()
