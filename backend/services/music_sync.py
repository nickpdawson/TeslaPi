"""Selective music sync engine — rsync with gadget lifecycle management."""

import asyncio
import contextlib
import json
import logging
import os
import re
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

# Serializes any mount/umount of MUSIC_MOUNT across this module and routers/music.py.
# Without this, the `/api/music/local` endpoint (which mount/umounts the same image
# read-only to scan it) can race with a running sync and yank the mount out from
# under rsync mid-transfer.
_image_mount_lock = asyncio.Lock()

MUSIC_MOUNT = "/mnt/music"
MUSIC_DEST = "/mnt/music/Music"
SHARE_MOUNT = "/mnt/music_share"
MUSIC_IMAGE = "/backingfiles/music_disk.bin"
GADGET_ENABLE = "/opt/teslapi/deploy/teslapi-gadget-enable.sh"
GADGET_DISABLE = "/opt/teslapi/deploy/teslapi-gadget-disable.sh"

# Extra retries for sync DB writes when a lock persists beyond the connection's 30s
# busy timeout (severe SD I/O contention during a large sync). Belt-and-suspenders on
# top of the busy timeout so a terminal-status or checkpoint write is never fatal.
_DB_WRITE_RETRIES = 6
_DB_WRITE_RETRY_DELAY_SEC = 0.75

@contextlib.asynccontextmanager
async def _connect(db_path: str):
    """Open the sync DB with the app-wide busy timeout + WAL. Delegates to the shared
    ``database.connect`` so every subsystem (sync, auto_sync, dashcam, status, index)
    uses the SAME generous busy timeout — a transient lock then waits instead of
    failing. Use as ``async with _connect(db_path) as db:``.
    """
    from backend.database import connect as _db_connect
    async with _db_connect(db_path) as db:
        yield db


async def _update_job_progress(db_path: str, job_id: int, **kwargs) -> None:
    """Best-effort progress write. The ~1 Hz files_copied/bytes_copied updates are
    cosmetic UI data; a lock (or any error) on one must NOT propagate and kill the
    transfer — that was the failure that repeatedly aborted the full-library sync.
    Swallow and log; the next update (or the terminal status write) will catch up.
    """
    try:
        await _update_job(db_path, job_id, **kwargs)
    except Exception as exc:  # noqa: BLE001 — progress is cosmetic; never fatal
        logger.debug("Sync job %s: progress update skipped (non-fatal): %s", job_id, exc)


async def _mark_batch_synced(db_path: str, batch: list[str]) -> None:
    """Mark a completed batch's files synced=1, retrying on a transient lock. A raised
    lock here would abort the whole sync (the files would re-copy next run), so absorb
    momentary "database is locked" the same way _update_job does."""
    for attempt in range(_DB_WRITE_RETRIES):
        try:
            async with _connect(db_path) as db:
                for path in batch:
                    await db.execute(
                        "UPDATE music_files SET synced = 1 WHERE path = ?",
                        (path,),
                    )
                await db.commit()
            return
        except Exception as exc:  # aiosqlite raises sqlite3.OperationalError
            if "locked" in str(exc).lower() and attempt < _DB_WRITE_RETRIES - 1:
                await asyncio.sleep(_DB_WRITE_RETRY_DELAY_SEC * (attempt + 1))
                continue
            raise


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

    # Refuse while the library is indexing: a sync marking files synced=1 must not
    # overlap a re-index resetting synced=0 for changed files, or the reset is lost
    # (changed file hidden from "Sync New"). They also contend for the share.
    from backend.services import music_index
    if music_index.get_indexing_status().get("active"):
        raise RuntimeError("The music library is indexing; try again once it finishes.")

    # Claim the slot SYNCHRONOUSLY (before any await) so a concurrent sync or an
    # index trigger can't slip in between the checks above and the claim. Also fixes
    # the old check-then-set race where two POSTs could both start a sync.
    _active_sync["job_id"] = -1
    _active_sync["cancelled"] = False
    _active_sync["process"] = None

    # NOTE: music sync toggles the USB gadget, which the preserved teslausb
    # archiveloop daemon also manages. Coordinating the two (so a sync doesn't yank
    # the gadget mid-archive) is an unresolved Phase 2/3 architectural decision —
    # see work log. Not gated here because archiveloop is enabled on every normal
    # install, so a blanket refusal would disable music sync everywhere.

    try:
        async with _connect(db_path) as db:
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
    except Exception:
        _active_sync["job_id"] = None  # release the claim on failure
        raise

    _active_sync["job_id"] = job_id

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
            # The disable script returns 0 for "already disabled" and non-zero ONLY when
            # the gadget is still bound to a UDC (the car can still write the drives).
            # Mounting the backing image RW now would put two writers on one FAT →
            # corruption. Abort BEFORE mounting; we haven't touched the image, and the
            # gadget is left as-is (car keeps its drives — the safe, recoverable state).
            raise RuntimeError(
                f"USB gadget disable failed (rc={result.returncode}): {result.stderr.strip()}. "
                "Refusing to mount the music image to avoid drive corruption."
            )

        # Tracks whether the music image is confirmed unmounted before we re-present
        # the gadget. The image must NEVER be re-exported to the car while still
        # host-mounted read-write (two writers → filesystem corruption).
        image_released = False
        try:
            # Step 2: Mount music disk image (skip if already mounted).
            # Serialize against /api/music/local which mounts the same image RO.
            async with _image_mount_lock:
                check = await script_runner.run("mountpoint", ["-q", MUSIC_MOUNT], timeout=5)
                if check.returncode == 0:
                    # Leftover mount (e.g. crashed prior run). Reuse it, but we still
                    # own releasing it before the gadget comes back — see Step 7.
                    logger.info("Sync job %d: music image already mounted (reusing)", job_id)
                else:
                    logger.info("Sync job %d: mounting music disk image", job_id)
                    # Detach any stale loop devices already bound to the image.
                    # `mount -o loop` returns 0 but silently fails to establish
                    # a mountpoint when the file is already loop-attached (e.g.
                    # left over from gadget setup or a prior crashed run).
                    losetup = await script_runner.run("losetup", ["-j", MUSIC_IMAGE], timeout=5)
                    if losetup.returncode == 0 and losetup.stdout.strip():
                        for line in losetup.stdout.splitlines():
                            dev = line.split(":", 1)[0].strip()
                            if dev.startswith("/dev/loop"):
                                logger.info("Sync job %d: detaching stale loop %s", job_id, dev)
                                await script_runner.run("losetup", ["-d", dev], timeout=5)

                    result = await script_runner.run(
                        "mount", ["-o", "loop", MUSIC_IMAGE, MUSIC_MOUNT], timeout=15,
                    )
                    if result.returncode != 0:
                        raise RuntimeError(f"Failed to mount music image: {result.stderr}")

                    # Verify the mount actually took — `mount` can return 0 without
                    # establishing a mountpoint in pathological loop-device states.
                    verify = await script_runner.run("mountpoint", ["-q", MUSIC_MOUNT], timeout=5)
                    if verify.returncode != 0:
                        raise RuntimeError(
                            f"mount returned 0 but {MUSIC_MOUNT} is not a mountpoint"
                        )

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
                    # _run_rsync_full sets status=completed itself; nothing more to do
                else:
                    # Selective sync: build the file list, then rsync it in bounded
                    # BATCHES rather than one giant --files-from. rsync stays silent
                    # during its file-list build (--info=progress2 emits nothing until
                    # it transfers), so a large list's scan can exceed the stall
                    # watchdog and be killed+retried forever with zero progress — the
                    # failure a full-library "Sync New" hit. Small batches scan fast,
                    # and each is checkpointed (synced=1 + progress persisted) so an
                    # interrupted sync resumes at the next batch instead of restarting.
                    file_list = await _build_file_list(paths, mode, db_path)
                    await _sync_file_list_in_batches(job_id, file_list, db_path)

            finally:
                # Step 7: Unmount source share and RELEASE the music image. We always
                # release it (regardless of who mounted it) and verify the release,
                # because Step 8 must not re-present a still-mounted RW image.
                logger.info("Sync job %d: unmounting", job_id)
                share_released = await share_browser.unmount_share(SHARE_MOUNT)
                if not share_released:
                    logger.warning("Sync job %d: source share unmount reported failure", job_id)
                async with _image_mount_lock:
                    image_released = await _ensure_image_unmounted(f"Sync job {job_id}")

        finally:
            # Step 8: Re-enable the USB gadget — but ONLY if the music image is
            # confirmed unmounted. Re-presenting a still-host-mounted RW image to the
            # car means two writers on one FAT filesystem → corruption. If we can't
            # release it, leave the gadget down (car temporarily loses its drives,
            # which is recoverable) and surface a hard failure.
            if image_released:
                logger.info("Sync job %d: re-enabling USB gadget", job_id)
                await script_runner.run(
                    "bash", [GADGET_ENABLE], timeout=15,
                )
            else:
                logger.critical(
                    "Sync job %d: music image could NOT be unmounted; NOT re-enabling "
                    "the gadget to avoid corrupting the drive. Manual intervention needed.",
                    job_id,
                )
                await _update_job(
                    db_path, job_id,
                    status="failed",
                    error_message="Music image could not be unmounted after sync; gadget left disabled to prevent corruption. Reboot or unmount /mnt/music manually.",
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
    async with _connect(db_path) as db:
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
    async with _connect(db_path) as db:
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


# rsync --info=progress2 emits a single periodic line, separated by \r:
#   "       1,234,567,890   3%   12.34MB/s    0:01:23 (xfr#42, to-chk=12345/67890)"
# to-chk=A/B means A files remain to check out of B total. Files done = B - A.
# ir-chk=A/B is the same shape during incremental file-list build.
_PROGRESS2_RE = re.compile(
    rb"^\s*([\d,]+)\s+\d+%\s+\S+\s+\S+\s+\(xfr#(\d+),\s+(?:to-chk|ir-chk)=(\d+)/(\d+)\)"
)


def _parse_progress2(line: bytes) -> tuple[int, int] | None:
    """Parse one rsync ``--info=progress2`` line into ``(run_bytes, files_done)``.

    rsync emits ``<bytes> <pct>% <rate> <elapsed> (xfr#N, to-chk=R/T)`` (or ``ir-chk``
    during incremental recursion), separated by ``\\r``. Files done = total - remaining.
    Returns None for any non-progress line so the caller skips it.
    """
    m = _PROGRESS2_RE.match(line)
    if not m:
        return None
    try:
        run_bytes = int(m.group(1).replace(b",", b""))
        remaining = int(m.group(3))
        total = int(m.group(4))
    except (ValueError, IndexError):
        return None
    return run_bytes, max(0, total - remaining)

# Watchdog timing
_STALL_TIMEOUT_SEC = 90.0      # rsync stdout silent for this long → assume wedged
_RETRY_BACKOFF_SEC = 5.0       # wait between rsync restart attempts
_MAX_RSYNC_RESTARTS = 50       # cap retries so a truly broken state doesn't loop forever
_SHARE_WAIT_TIMEOUT_SEC = 3600 # how long we'll wait for the source share to come back

# A selective sync rsyncs its file list in batches of this many files rather than one
# giant --files-from. rsync is SILENT during its file-list build (--info=progress2
# prints nothing until it transfers), so a huge list's scan can exceed the stall
# watchdog and be killed+retried forever with zero progress — the exact failure a
# full-library "Sync New" hit. A small batch's scan finishes in well under the
# watchdog, and each completed batch is checkpointed (synced=1 + progress persisted)
# so an interrupted sync resumes instead of restarting. Kept modest so checkpoints
# are frequent over the slow CIFS/FAT write path.
_SYNC_BATCH_FILES = 50


def _batch_file_list(file_list: list[str], max_files: int = _SYNC_BATCH_FILES) -> list[list[str]]:
    """Split an ordered file list into consecutive batches of at most ``max_files``.

    Order is preserved, so batches stay artist/album-contiguous (the DB hands paths
    back grouped) — good for rsync locality — while the fixed cap bounds each rsync's
    file-list scan so it can't recreate the giant-enumeration stall. Per-file synced
    bookkeeping makes album boundaries irrelevant to correctness, so a plain fixed
    chunk is both simplest and safe.
    """
    if max_files < 1:
        max_files = 1
    return [file_list[i:i + max_files] for i in range(0, len(file_list), max_files)]


async def _sync_file_list_in_batches(job_id: int, file_list: list[str], db_path: str) -> None:
    """rsync ``file_list`` to the music image in bounded batches, checkpointing each.

    Each batch is a small ``--files-from`` so rsync's (silent) file-list scan stays
    well under the stall watchdog. After a clean batch its files are marked synced=1
    and cumulative progress is persisted, so a sync interrupted by a short window
    resumes at the next batch instead of restarting. A partial batch (rsync 23/24)
    leaves its files unsynced to retry next time and the sync continues; a hard batch
    failure (supervisor exhausted its own retries) aborts, with completed batches
    already checkpointed. Sets the job's terminal status (completed/partial).

    Must be called with the music image mounted and the gadget disabled (the caller's
    responsibility); it does not touch the mount/gadget lifecycle.
    """
    if not file_list:
        logger.info("Sync job %d: no files to sync", job_id)
        await _update_job(db_path, job_id, status="completed")
        return

    batches = _batch_file_list(file_list, _SYNC_BATCH_FILES)
    logger.info(
        "Sync job %d: %d files in %d batch(es) of <=%d",
        job_id, len(file_list), len(batches), _SYNC_BATCH_FILES,
    )

    copied_files = 0    # files in fully-transferred batches (authoritative count)
    copied_bytes = 0    # bytes transferred so far, for a monotonic UI total
    any_partial = False

    for batch_idx, batch in enumerate(batches, 1):
        if _active_sync["cancelled"]:
            raise asyncio.CancelledError()

        with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False) as f:
            for path in batch:
                f.write(path.lstrip("/") + "\n")
            files_from = f.name

        try:
            success, rc, err, run_bytes = await _supervise_rsync(
                job_id, db_path, [f"--files-from={files_from}"],
                bytes_offset=copied_bytes,
                files_offset=copied_files,
            )
        finally:
            os.unlink(files_from)

        # Count bytes transferred regardless of exit so the UI total never rewinds
        # between batches.
        copied_bytes += run_bytes

        if success:
            # Checkpoint: mark this batch synced and persist cumulative progress.
            # Marking happens ONLY on a clean batch (rc 0), so a partial/failed batch
            # leaves its files unsynced for the next sync to retry.
            await _mark_batch_synced(db_path, batch)
            copied_files += len(batch)
            await _update_job(
                db_path, job_id,
                files_copied=copied_files,
                bytes_copied=copied_bytes,
            )
        elif rc in (23, 24):
            # Partial batch (vanished/unreadable files). Leave these unsynced so the
            # next sync retries the gaps; keep going with the remaining batches.
            any_partial = True
            logger.warning(
                "Sync job %d: batch %d/%d partial (rsync %s)",
                job_id, batch_idx, len(batches), rc,
            )
        else:
            # Hard failure after the supervisor exhausted its own retries — the
            # share/link is likely down. Abort; completed batches are already
            # checkpointed (synced=1), so a re-run resumes from here.
            raise RuntimeError(
                f"rsync failed on batch {batch_idx}/{len(batches)}: {err}"
            )

    if any_partial:
        # files_copied already reflects only the fully-transferred batches.
        await _update_job(
            db_path, job_id,
            status="partial",
            error_message="Some files could not be copied; they will retry on the next sync.",
        )
    else:
        await _update_job(
            db_path, job_id,
            status="completed",
            files_copied=copied_files,
        )


class _RsyncStalled(Exception):
    """Raised when rsync produces no stdout for too long — pipeline likely wedged."""


async def _stream_rsync_progress(
    proc,
    db_path: str,
    job_id: int,
    *,
    bytes_offset: int = 0,
    files_offset: int = 0,
    stall_timeout: float = _STALL_TIMEOUT_SEC,
    progress: dict | None = None,
) -> tuple[int, int]:
    """Read rsync stdout in raw chunks, parse --info=progress2 lines, update DB ~1Hz.

    rsync uses \\r (not \\n) between progress updates, so async-for-line doesn't
    yield until process exit. Read raw bytes and split on both separators.

    ``bytes_offset`` is the cumulative bytes transferred by PRIOR rsync runs; it is
    added to this run's byte count only for the DB write, so the UI total stays
    monotonic across restarts. The returned/holder byte count is THIS run only.
    ``files_offset`` does the same for the file counter — the count of files copied
    by prior runs/batches — so files_copied stays monotonic when a large sync is
    rsynced in several batches.

    ``progress`` (if given) is updated in place with ``{"run_bytes", "files"}`` on
    every parse and before raising ``_RsyncStalled`` — the supervisor reads it to
    keep the cumulative total correct even when a run is killed mid-transfer.

    Raises ``_RsyncStalled`` if rsync produces no output for ``stall_timeout``
    seconds — the supervisor uses this signal to kill+retry.

    Returns ``(last_files, run_bytes)`` — run_bytes is this run's transfer only.
    """
    last_update = 0.0
    last_files = 0
    run_bytes = 0
    buf = b""

    def _publish() -> None:
        if progress is not None:
            progress["run_bytes"] = run_bytes
            progress["files"] = last_files

    while True:
        try:
            chunk = await asyncio.wait_for(proc.stdout.read(4096), timeout=stall_timeout)
        except asyncio.TimeoutError:
            _publish()
            raise _RsyncStalled(f"rsync silent for {stall_timeout:.0f}s")

        if not chunk:
            break  # rsync closed stdout — process is exiting
        if _active_sync["cancelled"]:
            _publish()
            proc.kill()
            await proc.wait()
            raise asyncio.CancelledError()

        buf += chunk
        parts = re.split(rb"[\r\n]", buf)
        buf = parts[-1]

        for line in parts[:-1]:
            parsed = _parse_progress2(line)
            if parsed is None:
                continue
            run_bytes, last_files = parsed

        _publish()
        now = time.monotonic()
        if now - last_update >= 1.0:
            # Best-effort: a locked progress write must not kill the transfer.
            await _update_job_progress(
                db_path, job_id,
                files_copied=files_offset + last_files,
                bytes_copied=bytes_offset + run_bytes,
            )
            last_update = now

    # Flush final progress (best-effort; cosmetic)
    _publish()
    await _update_job_progress(
        db_path, job_id,
        files_copied=files_offset + last_files,
        bytes_copied=bytes_offset + run_bytes,
    )
    return last_files, run_bytes


async def _share_responsive(timeout_sec: float = 8.0) -> bool:
    """Quick liveness probe of the music source share. True if a stat returns
    promptly. False on timeout, error, or share unmounted."""
    if not await share_browser.is_mounted(SHARE_MOUNT):
        return False
    try:
        proc = await asyncio.create_subprocess_exec(
            "stat", SHARE_MOUNT,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await asyncio.wait_for(proc.wait(), timeout=timeout_sec)
        return proc.returncode == 0
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except ProcessLookupError:
            pass
        return False
    except Exception:
        return False


async def _remount_music_share() -> bool:
    """Force-remount the music source share. Used when CIFS state is wedged.
    Returns True on success."""
    logger.info("Force-remounting music source share")
    try:
        await share_browser.unmount_share(SHARE_MOUNT)
    except Exception as exc:
        logger.warning("unmount of %s failed (continuing): %s", SHARE_MOUNT, exc)

    cfg = share_browser.get_music_share_config()
    if not cfg:
        return False
    import os as _os
    _os.makedirs(SHARE_MOUNT, exist_ok=True)
    try:
        return await share_browser.mount_share(
            share_type=cfg.get("share_type", cfg.get("type", "cifs")),
            server=cfg.get("server", ""),
            path=cfg.get("share_name", cfg.get("path", "")),
            mountpoint=SHARE_MOUNT,
            username=cfg.get("username", ""),
            password=cfg.get("password", ""),
            domain=cfg.get("domain", ""),
        )
    except Exception as exc:
        logger.warning("remount of music share failed: %s", exc)
        return False


async def _wait_for_share_reachable(job_id: int, total_timeout: float = _SHARE_WAIT_TIMEOUT_SEC) -> None:
    """Block until the music source share is responsive. Polls every 10s, attempting
    a remount each iteration. Raises RuntimeError after total_timeout."""
    deadline = time.monotonic() + total_timeout
    attempt = 0
    while time.monotonic() < deadline:
        if _active_sync["cancelled"]:
            raise asyncio.CancelledError()

        if await _share_responsive():
            if attempt > 0:
                logger.info("Sync job %d: share recovered after %d attempt(s)", job_id, attempt)
            return

        attempt += 1
        if attempt == 1 or attempt % 6 == 0:  # log first try and every minute
            logger.warning("Sync job %d: music share unresponsive, attempt %d", job_id, attempt)

        await _remount_music_share()
        await asyncio.sleep(10)

    raise RuntimeError(f"music share unreachable for {total_timeout:.0f}s")


async def _drain_stream(stream, limit: int = 65536) -> str:
    """Read a subprocess pipe to EOF, keeping at most the last ``limit`` bytes.

    Draining stderr concurrently with stdout is essential: rsync writes warnings
    (vanished files, CIFS I/O errors) to stderr, and if that ~64 KB pipe fills,
    rsync blocks on write, stops emitting stdout progress, and the stall watchdog
    fires a false positive. Keeping only the tail bounds memory on a chatty run.
    """
    chunks: list[bytes] = []
    size = 0
    try:
        while True:
            chunk = await stream.read(4096)
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
            if size > limit:
                tail = b"".join(chunks)[-limit:]
                chunks = [tail]
                size = len(tail)
    except Exception:  # pragma: no cover - best-effort drain
        pass
    return b"".join(chunks).decode("utf-8", errors="replace")


# rsync exit-code policy for the supervisor. Partial codes (vanished/unreadable
# files) are handed back without endless retries; network-flavored codes get a fresh
# CIFS mount before retrying.
_RSYNC_PARTIAL_CODES = frozenset({23, 24})
_RSYNC_REMOUNT_CODES = frozenset({30, 35, 12, 11, 14})


def _classify_rsync_exit(rc: int | None) -> str:
    """Map an rsync exit code to the supervisor's action:
    'success' (0), 'partial' (23/24 — hand back, don't retry forever),
    'retry_remount' (network-flavored — remount then retry), or 'retry' (other)."""
    if rc == 0:
        return "success"
    if rc in _RSYNC_PARTIAL_CODES:
        return "partial"
    if rc in _RSYNC_REMOUNT_CODES:
        return "retry_remount"
    return "retry"


async def _supervise_rsync(
    job_id: int,
    db_path: str,
    extra_args: list[str],
    *,
    bytes_offset: int = 0,
    files_offset: int = 0,
) -> tuple[bool, int | None, str, int]:
    """Run rsync with stall-detection, concurrent stderr draining, auto-resume on
    share outage, and monotonic cumulative byte accounting.

    ``extra_args`` are inserted before the src/dst (e.g. ``--files-from=...``).
    On a stall (no stdout for _STALL_TIMEOUT_SEC) or a retryable non-success exit,
    rsync is killed, the share is re-checked/remounted, and rsync is restarted;
    ``rsync -a`` skips already-correct files cheaply, so this is robust to repeated
    WiFi drops.

    ``bytes_offset``/``files_offset`` are the cumulative bytes/files transferred by
    PRIOR batches; they're added to the live DB progress writes so a multi-batch sync
    reports a monotonic running total (this call's own runs still start from 0).

    Returns ``(success, final_rc, error, run_bytes)`` where ``success`` is True only
    on exit code 0 and ``run_bytes`` is the bytes THIS call transferred (summed across
    its internal retries). Partial codes (23/24) return ``(False, rc, error, run_bytes)``
    without endless retries so the caller decides how to record them. Propagates
    ``asyncio.CancelledError`` on user cancel.
    """
    import os
    check_music = await script_runner.run("mountpoint", ["-q", MUSIC_MOUNT], timeout=5)
    if check_music.returncode != 0:
        raise RuntimeError(f"Music image not mounted at {MUSIC_MOUNT} — cannot sync")

    os.makedirs(MUSIC_DEST, exist_ok=True)

    cmd = [
        "rsync",
        "-a",
        "--partial",
        "--timeout=120",
        "--info=progress2",
        "--info=name0",
        *extra_args,
        f"{SHARE_MOUNT}/",
        f"{MUSIC_DEST}/",
    ]

    cumulative_bytes = 0
    last_error = ""
    last_rc: int | None = None

    for attempt in range(1, _MAX_RSYNC_RESTARTS + 1):
        if _active_sync["cancelled"]:
            raise asyncio.CancelledError()

        # Make sure the share is reachable before spawning rsync. On retries this
        # also handles the "Tesla drove away → WiFi gone → CIFS wedged" case.
        await _wait_for_share_reachable(job_id)

        logger.info("Sync job %d: rsync attempt %d/%d", job_id, attempt, _MAX_RSYNC_RESTARTS)

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _active_sync["process"] = proc
        stderr_task = asyncio.create_task(_drain_stream(proc.stderr))
        progress = {"run_bytes": 0, "files": 0}
        stalled = False
        stderr_text = ""

        try:
            try:
                await _stream_rsync_progress(
                    proc, db_path, job_id,
                    bytes_offset=bytes_offset + cumulative_bytes,
                    files_offset=files_offset,
                    progress=progress,
                )
            except _RsyncStalled as exc:
                stalled = True
                last_error = f"stalled (attempt {attempt})"
                logger.warning("Sync job %d: rsync stalled (%s), killing", job_id, exc)
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass
            # Reap the process so it can't linger holding the mount busy.
            try:
                await asyncio.wait_for(proc.wait(), timeout=15)
            except asyncio.TimeoutError:
                logger.error("Sync job %d: rsync didn't exit within 15s; killing", job_id)
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass
                await proc.wait()
        finally:
            # Always account this run's bytes and always reap the stderr drain,
            # including on the cancel path (CancelledError propagates after this).
            cumulative_bytes += progress["run_bytes"]
            try:
                stderr_text = await asyncio.wait_for(stderr_task, timeout=5)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                stderr_task.cancel()

        if stalled:
            await asyncio.sleep(_RETRY_BACKOFF_SEC)
            # Fresh CIFS connection before the next attempt.
            await _remount_music_share()
            continue

        rc = proc.returncode
        last_rc = rc
        kind = _classify_rsync_exit(rc)
        if kind == "success":
            logger.info("Sync job %d: rsync completed on attempt %d", job_id, attempt)
            return True, rc, "", cumulative_bytes
        if kind == "partial":
            # Partial transfer (vanished/unreadable files). Not retried forever —
            # hand back to the caller to record; a later sync retries the gaps.
            logger.warning("Sync job %d: rsync partial (code %d): %s", job_id, rc, stderr_text[:200])
            return False, rc, stderr_text[:200], cumulative_bytes

        last_error = f"exit {rc}: {stderr_text[:200]}"
        logger.warning("Sync job %d: rsync exit %d on attempt %d, will retry: %s",
                       job_id, rc, attempt, stderr_text[:200])
        await asyncio.sleep(_RETRY_BACKOFF_SEC)
        # Network-flavored failures benefit from a fresh CIFS mount before retry.
        if kind == "retry_remount":
            await _remount_music_share()

    logger.error("Sync job %d: gave up after %d attempts: %s", job_id, _MAX_RSYNC_RESTARTS, last_error)
    return False, last_rc, f"failed after {_MAX_RSYNC_RESTARTS} attempts: {last_error[:200]}", cumulative_bytes


def _path_mount_state(path: str) -> bool | None:
    """Definitively report whether ``path`` is a mount point, read from
    /proc/self/mountinfo (authoritative for this process's mount namespace, which
    the mount subprocesses share). Returns True (mounted), False (definitively not
    mounted), or None if it could not be determined. Unlike `mountpoint`'s exit
    code, a read error is reported as None rather than masquerading as "not
    mounted" — the caller must treat None as "still mounted" for safety."""
    try:
        target = os.path.realpath(path)
        with open("/proc/self/mountinfo", "r", encoding="utf-8", errors="replace") as fh:
            return _mountinfo_has_target(fh, target)
    except Exception:
        # Any failure to read/parse is undeterminable, not proof of "not mounted".
        return None


def _mountinfo_has_target(lines, target: str) -> bool:
    """True if ``target`` appears as a mount point in /proc/self/mountinfo ``lines``.

    Per proc(5), the mount point is field index 4 (space-separated). Getting this
    index wrong would misreport mount state and could green-light re-enabling the USB
    gadget over a still-mounted image (corruption), so it's isolated + tested.
    """
    for line in lines:
        fields = line.split()
        if len(fields) > 4 and fields[4] == target:
            return True
    return False


async def _image_loop_devices() -> list[str] | None:
    """Return the loop devices currently backed by the music image, or None if it
    could not be determined. Empty list means none are attached. ``losetup -j``
    exits 0 with empty output when there are no matches; a non-zero exit is an error
    we must not mistake for "no loops"."""
    res = await script_runner.run("losetup", ["-j", MUSIC_IMAGE], timeout=5)
    if res.returncode != 0:
        # util-linux `losetup -j` exits 0 (with empty output) when there are simply
        # no matches, so a non-zero exit is a real error — binary missing, timeout,
        # permission. We cannot conclude "no loops" from it; report undeterminable
        # so the caller fails safe (treats the image as still attached).
        return None
    devs = []
    for line in res.stdout.splitlines():
        dev = line.split(":", 1)[0].strip()
        if dev.startswith("/dev/loop"):
            devs.append(dev)
    return devs


async def _detach_image_loops(log_ctx: str) -> bool:
    """Detach every loop device bound to the music image and CONFIRM none remain.
    Returns True only when the image is verified free of loop devices; False on any
    detach failure or if the state can't be confirmed. Safe to call only while the
    gadget is disabled (the gadget owns no loop then). A lingering loop can write
    back to the image, so a False result must block re-presenting it to the car."""
    devs = await _image_loop_devices()
    if devs is None:
        logger.warning("%s: could not enumerate loop devices for %s; treating as still attached", log_ctx, MUSIC_IMAGE)
        return False
    for dev in devs:
        logger.info("%s: detaching loop %s", log_ctx, dev)
        await script_runner.run("losetup", ["-d", dev], timeout=5)
    remaining = await _image_loop_devices()
    if remaining is None:
        logger.warning("%s: could not verify loop detach for %s; treating as still attached", log_ctx, MUSIC_IMAGE)
        return False
    if remaining:
        logger.warning("%s: loop device(s) still bound to %s after detach: %s", log_ctx, MUSIC_IMAGE, remaining)
        return False
    return True


async def _ensure_image_unmounted(log_ctx: str = "image release", retries: int = 5) -> bool:
    """Unmount the music image and POSITIVELY confirm it is gone before the gadget is
    re-presented. Flushes with ``sync`` and retries; returns True only on a definite
    "not mounted" reading (never on an undeterminable check — that is treated as
    still mounted so we fail safe). Deliberately does NOT use lazy umount — a lazy
    detach can leave writes in flight, exactly the corruption we guard against.
    Caller must hold ``_image_mount_lock``."""
    for i in range(retries):
        state = _path_mount_state(MUSIC_MOUNT)
        if state is False:
            # Confirmed unmounted. Only declare it released once we've also verified
            # no loop device is still bound to the image — a lingering loop can write
            # back behind the gadget's back. A detach failure keeps us in the retry
            # loop (and ultimately returns False → gadget stays down).
            if await _detach_image_loops(log_ctx):
                return True
            logger.warning(
                "%s: %s unmounted but a loop device is still attached (attempt %d/%d)",
                log_ctx, MUSIC_MOUNT, i + 1, retries,
            )
            await asyncio.sleep(1)
            continue
        if state is None:
            logger.warning(
                "%s: could not determine mount state of %s (attempt %d/%d); treating as still mounted",
                log_ctx, MUSIC_MOUNT, i + 1, retries,
            )
        else:  # definitely mounted — flush and unmount
            await script_runner.run("sync", [], timeout=30)
            res = await script_runner.run("umount", [MUSIC_MOUNT], timeout=15)
            if res.returncode != 0:
                logger.warning(
                    "%s: umount %s failed (attempt %d/%d): %s",
                    log_ctx, MUSIC_MOUNT, i + 1, retries, res.stderr,
                )
        await asyncio.sleep(1)
    return False


async def _run_rsync_full(job_id: int, db_path: str) -> None:
    """Full rsync of the entire share via the supervised runner."""
    success, rc, err, _run_bytes = await _supervise_rsync(job_id, db_path, [])
    if success:
        logger.info("Sync job %d: full rsync completed", job_id)
        # Deliberately do NOT bulk-mark synced here. Marking based on a filesystem
        # snapshot is a fragile optimization: a blanket mark hides uncopied files,
        # and a SELECT-then-UPDATE races a concurrent re-index (which resets synced=0
        # when it detects a changed file) — overwriting that reset would permanently
        # hide the changed file from "Sync New". Leaving synced untouched is safe:
        # the next "Sync New" re-offers not-yet-synced files, and its selective rsync
        # skips already-copied ones (near no-op) while correctly marking what it
        # copies. Under-marking costs a cheap re-scan; over-marking loses data.
        await _update_job(db_path, job_id, status="completed")
        return
    if rc in (23, 24):
        # Partial transfer — report honestly rather than as a clean success.
        logger.warning("Sync job %d: full rsync partial (code %s)", job_id, rc)
        await _update_job(
            db_path, job_id,
            status="partial",
            error_message=f"Some files could not be copied (rsync code {rc}); they will retry on the next sync.",
        )
        return
    await _update_job(db_path, job_id, status="failed", error_message=err)


async def get_sync_status(db_path: str, job_id: int | None = None) -> dict | None:
    """Get current/latest sync job status."""
    async with _connect(db_path) as db:
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
    async with _connect(db_path) as db:
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
            if val in ("completed", "failed", "cancelled", "partial"):
                set_clauses.append("completed_at = ?")
                values.append(datetime.now(timezone.utc).isoformat())
        else:
            set_clauses.append(f"{key} = ?")
            values.append(val)

    values.append(job_id)

    sql = f"UPDATE music_sync_jobs SET {', '.join(set_clauses)} WHERE id = ?"
    # Retry on a transient lock beyond the connection busy timeout. This runs during
    # a sync while rsync saturates the SD card, so terminal-status and checkpoint
    # writes must not fail on a momentary "database is locked" — that recurring
    # failure is what aborted the full-library sync even with a 30s busy timeout.
    for attempt in range(_DB_WRITE_RETRIES):
        try:
            async with _connect(db_path) as db:
                await db.execute(sql, values)
                await db.commit()
            return
        except Exception as exc:  # aiosqlite raises sqlite3.OperationalError
            if "locked" in str(exc).lower() and attempt < _DB_WRITE_RETRIES - 1:
                await asyncio.sleep(_DB_WRITE_RETRY_DELAY_SEC * (attempt + 1))
                continue
            raise
