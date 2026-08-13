"""Music library and sync API endpoints."""

import asyncio
import logging
import time
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from backend.config import settings
from backend import database
from backend.services import music_index, music_sync, share_browser

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/music")


def _safe_delete_target(mount_point: str, rel_path: str) -> str | None:
    """Resolve a user-supplied relative path for deletion, or None if it's unsafe.

    Security-critical (fable C3): without this, `../music_share/...` or an absolute
    path or an escaping symlink could make delete rmtree the NAS source share instead
    of a folder on the music image. Rules: fully resolve symlinks/.. with realpath,
    require the result to stay strictly inside the mount root via commonpath (NOT a
    string prefix — `/mnt/music_share` must not pass the `/mnt/music` root), and refuse
    the mount root itself.
    """
    import os

    target = os.path.realpath(os.path.join(mount_point, rel_path))
    root = os.path.realpath(mount_point)
    if target == root:
        return None  # refuse deleting the drive root
    if os.path.commonpath([target, root]) != root:
        return None  # escapes the mount
    return target


# Music share mount management
MUSIC_SHARE_MOUNT = "/mnt/music_share"
_mount_lock = asyncio.Lock()
_last_mount_access: float = 0
_unmount_task: Optional[asyncio.Task] = None
MOUNT_IDLE_TIMEOUT = 300  # 5 minutes


class SyncRequest(BaseModel):
    paths: list[str] = []
    mode: str = "selected"  # "selected" | "random" | "recent" | "full"
    count: int = 20
    type: str = "artist"  # for random mode: "artist" | "album"


class DeleteLocalRequest(BaseModel):
    path: str  # relative path inside music image, e.g. "Music/Amy Winehouse"


async def _ensure_music_share_mounted() -> str:
    """Mount the music share on demand if not already mounted. Returns mountpoint."""
    global _last_mount_access, _unmount_task

    _last_mount_access = time.time()

    # Cancel any pending unmount
    if _unmount_task and not _unmount_task.done():
        _unmount_task.cancel()

    if await share_browser.is_mounted(MUSIC_SHARE_MOUNT):
        # Schedule idle unmount
        _unmount_task = asyncio.create_task(_schedule_unmount())
        return MUSIC_SHARE_MOUNT

    async with _mount_lock:
        # Double-check after acquiring lock
        if await share_browser.is_mounted(MUSIC_SHARE_MOUNT):
            _unmount_task = asyncio.create_task(_schedule_unmount())
            return MUSIC_SHARE_MOUNT

        config = share_browser.get_music_share_config()
        if not config:
            raise HTTPException(
                status_code=503,
                detail="Music share not configured. Set music_share_server and music_share_name in teslausb config.",
            )

        success = await share_browser.mount_share(
            share_type=config["share_type"],
            server=config["server"],
            path=config["share_name"],
            mountpoint=MUSIC_SHARE_MOUNT,
            username=config.get("username", ""),
            password=config.get("password", ""),
            domain=config.get("domain", ""),
        )

        if not success:
            raise HTTPException(status_code=503, detail="Failed to mount music share")

        _unmount_task = asyncio.create_task(_schedule_unmount())
        return MUSIC_SHARE_MOUNT


def _should_unmount_idle(elapsed: float, sync_active: bool) -> bool:
    """Whether the idle timer should lazy-unmount the music share this cycle.

    A sync uses the SAME mountpoint (music_sync.SHARE_MOUNT == MUSIC_SHARE_MOUNT ==
    /mnt/music_share), so unmounting while a sync runs would `umount -l` the source out
    from under rsync mid-transfer. Only unmount once idle AND no sync is active.
    """
    return elapsed >= MOUNT_IDLE_TIMEOUT and not sync_active


async def _schedule_unmount() -> None:
    """Unmount the music share after idle timeout."""
    global _last_mount_access
    while True:
        await asyncio.sleep(30)  # Check every 30s
        elapsed = time.time() - _last_mount_access
        sync_active = music_sync._active_sync.get("job_id") is not None
        if sync_active:
            # Defer while a sync holds the share; keep checking. The sync manages its
            # own unmount when it finishes.
            _last_mount_access = time.time()  # push the idle window past the sync
            continue
        if _should_unmount_idle(elapsed, sync_active):
            if await share_browser.is_mounted(MUSIC_SHARE_MOUNT):
                logger.info("Unmounting idle music share after %.0fs", elapsed)
                await share_browser.unmount_share(MUSIC_SHARE_MOUNT)
            break


# --- Library endpoints ---


@router.get("/library/stats")
async def library_stats() -> dict:
    """Get library statistics: total artists, albums, tracks, size."""
    try:
        stats = await music_index.get_stats(settings.database_path)
        return stats
    except Exception as exc:
        logger.error("Failed to get library stats: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/library/artists")
async def list_artists(
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    search: str = Query("", alias="search"),
) -> dict:
    """Paginated artist list with optional search filter."""
    try:
        result = await music_index.get_artists(
            settings.database_path, limit=limit, offset=offset, search_query=search,
        )
        return result
    except Exception as exc:
        logger.error("Failed to list artists: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/library/artists/{artist}/albums")
async def list_albums(artist: str) -> dict:
    """Albums for a specific artist."""
    try:
        albums = await music_index.get_albums(settings.database_path, artist)
        return {"artist": artist, "albums": albums}
    except Exception as exc:
        logger.error("Failed to list albums for %s: %s", artist, exc)
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/library/search")
async def search_library(
    q: str = Query(..., min_length=1),
    limit: int = Query(50, ge=1, le=200),
) -> dict:
    """Full-text search across all fields."""
    try:
        results = await music_index.search(settings.database_path, q, limit=limit)
        return {"query": q, "results": results, "count": len(results)}
    except Exception as exc:
        logger.error("Search failed for '%s': %s", q, exc)
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/library/browse")
async def browse_library(
    path: str = Query("/"),
    offset: int = Query(0, ge=0),
    limit: int = Query(200, ge=1, le=500),
    filter: str = Query(""),
) -> dict:
    """Browse the mounted music share directory tree with pagination and optional filter."""
    try:
        mountpoint = await _ensure_music_share_mounted()
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            None, share_browser.browse_paginated, mountpoint, path, offset, limit, filter
        )
        return result
    except HTTPException:
        raise
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    except Exception as exc:
        logger.error("Browse failed for path '%s': %s", path, exc)
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/library/random")
async def random_items(
    count: int = Query(20, ge=1, le=100),
    type: str = Query("artist"),
) -> dict:
    """Return N random artists or albums from the index."""
    try:
        items = await music_index.get_random(settings.database_path, count=count, item_type=type)
        return {"items": items, "count": len(items), "type": type}
    except Exception as exc:
        logger.error("Random selection failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/library/recent")
async def recent_items(
    count: int = Query(50, ge=1, le=200),
) -> dict:
    """Return most recently modified items from the index."""
    try:
        items = await music_index.get_recent(settings.database_path, count=count)
        return {"items": items, "count": len(items)}
    except Exception as exc:
        logger.error("Recent items failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/library/index")
async def trigger_index() -> dict:
    """Trigger re-indexing of the music library."""
    # Don't index during a sync — a re-index resetting synced=0 for a changed file
    # would race the sync's synced=1 marking (lost reset → file hidden). They also
    # contend for the share.
    if music_sync._active_sync.get("job_id") is not None:
        raise HTTPException(status_code=409, detail="A music sync is in progress; index after it finishes.")
    if music_index.get_indexing_status()["active"]:
        raise HTTPException(status_code=409, detail="Indexing already in progress")

    mountpoint = await _ensure_music_share_mounted()

    # Re-check + claim SYNCHRONOUSLY right before spawning the task (no await between
    # the claim and create_task), so a sync starting during the mount await above is
    # seen, and start_sync (which checks indexing active) will refuse.
    if music_sync._active_sync.get("job_id") is not None:
        raise HTTPException(status_code=409, detail="A music sync is in progress; index after it finishes.")
    if not music_index.try_claim_indexing():
        raise HTTPException(status_code=409, detail="Indexing already in progress")

    asyncio.create_task(music_index.index_library(mountpoint, settings.database_path))
    return {"message": "Indexing started", "status": "indexing"}


@router.get("/library/index/status")
async def index_status() -> dict:
    """Get current indexing progress."""
    return music_index.get_indexing_status()


# --- Local music endpoints (reads from the Pi's music disk image) ---


@router.get("/local")
async def get_local_music() -> dict:
    """Scan the local music drive image for synced content.

    Mounts the music image read-only, walks /mnt/music/Music/, builds an
    artist/album/track tree, then unmounts. In dev mode returns mock data.
    """
    if settings.dev_mode:
        return _mock_local_music()

    from backend.services import script_runner
    import os

    mount_point = music_sync.MUSIC_MOUNT
    music_dir = music_sync.MUSIC_DEST
    image_path = music_sync.MUSIC_IMAGE

    # If a sync is in progress, the image is mounted RW by the sync. Don't fight
    # it — our RO remount or umount could corrupt rsync mid-flight. The UI shows
    # a "syncing" state from /api/music/sync/status; serving a stale/empty tree
    # here is the right behavior.
    if music_sync._active_sync.get("job_id") is not None:
        return {"artists": [], "total_size": 0, "total_tracks": 0, "capacity_bytes": 0, "syncing": True}

    # Serialize with music_sync._run_sync's mount step.
    async with music_sync._image_mount_lock:
        # Re-check after acquiring the lock — a sync may have started while we waited.
        if music_sync._active_sync.get("job_id") is not None:
            return {"artists": [], "total_size": 0, "total_tracks": 0, "capacity_bytes": 0, "syncing": True}

        we_mounted = False
        check = await script_runner.run("mountpoint", ["-q", mount_point], timeout=5)
        if check.returncode != 0:
            result = await script_runner.run(
                "mount", ["-o", "loop,ro", image_path, mount_point], timeout=15,
            )
            if result.returncode != 0:
                raise HTTPException(status_code=503, detail=f"Failed to mount music image: {result.stderr}")
            we_mounted = True

        try:
            artists = []
            total_size = 0
            total_tracks = 0
            capacity_bytes = 0

            if os.path.isdir(music_dir):
                loop = asyncio.get_event_loop()
                artists, total_size, total_tracks = await loop.run_in_executor(
                    None, _scan_local_music_dir, music_dir
                )
            # Real capacity of the mounted music image (its FAT filesystem total),
            # so the UI usage bar reflects the actual drive size instead of a
            # hardcoded 1.7 TB that made every drive look ~empty.
            try:
                st = os.statvfs(mount_point)
                capacity_bytes = st.f_blocks * st.f_frsize
            except OSError:
                capacity_bytes = 0
        finally:
            # Only ever unmount what WE mounted. Never unmount a mount established
            # by a sync (or anyone else).
            if we_mounted:
                await script_runner.run("umount", [mount_point], timeout=15)

    return {
        "artists": artists,
        "total_size": total_size,
        "total_tracks": total_tracks,
        "capacity_bytes": capacity_bytes,
    }


def _scan_local_music_dir(music_dir: str) -> tuple:
    """Walk the local music directory and build artist/album/track tree."""
    import os

    artists = []
    total_size = 0
    total_tracks = 0

    try:
        entries = sorted(os.listdir(music_dir))
    except OSError:
        return artists, total_size, total_tracks

    for artist_name in entries:
        artist_path = os.path.join(music_dir, artist_name)
        if not os.path.isdir(artist_path):
            continue

        artist_albums = []
        artist_size = 0
        artist_tracks = 0

        for album_name in sorted(os.listdir(artist_path)):
            album_path = os.path.join(artist_path, album_name)
            if os.path.isdir(album_path):
                tracks = []
                album_size = 0
                for fname in sorted(os.listdir(album_path)):
                    fpath = os.path.join(album_path, fname)
                    if os.path.isfile(fpath):
                        fsize = os.path.getsize(fpath)
                        tracks.append({"name": fname, "size": fsize})
                        album_size += fsize
                artist_albums.append({
                    "name": album_name,
                    "tracks": tracks,
                    "track_count": len(tracks),
                    "total_size": album_size,
                })
                artist_size += album_size
                artist_tracks += len(tracks)
            elif os.path.isfile(album_path):
                # Loose file directly under artist (no album folder)
                fsize = os.path.getsize(album_path)
                artist_size += fsize
                artist_tracks += 1

        artists.append({
            "name": artist_name,
            "albums": artist_albums,
            "total_tracks": artist_tracks,
            "total_size": artist_size,
        })
        total_size += artist_size
        total_tracks += artist_tracks

    return artists, total_size, total_tracks


def _mock_local_music() -> dict:
    """Return mock local music data for dev mode."""
    return {
        "artists": [
            {
                "name": "Amy Winehouse",
                "albums": [
                    {
                        "name": "Back to Black",
                        "tracks": [
                            {"name": "Rehab.flac", "size": 22_000_000},
                            {"name": "You Know I'm No Good.flac", "size": 25_000_000},
                            {"name": "Me & Mr Jones.flac", "size": 18_000_000},
                            {"name": "Just Friends.flac", "size": 20_000_000},
                            {"name": "Back to Black.flac", "size": 24_000_000},
                        ],
                        "track_count": 5,
                        "total_size": 109_000_000,
                    },
                    {
                        "name": "Frank",
                        "tracks": [
                            {"name": "Stronger Than Me.flac", "size": 21_000_000},
                            {"name": "Take the Box.flac", "size": 19_000_000},
                            {"name": "In My Bed.flac", "size": 20_000_000},
                            {"name": "Pumps.flac", "size": 20_000_000},
                        ],
                        "track_count": 4,
                        "total_size": 80_000_000,
                    },
                ],
                "total_tracks": 9,
                "total_size": 189_000_000,
            },
            {
                "name": "Dire Straits",
                "albums": [
                    {
                        "name": "Brothers in Arms",
                        "tracks": [
                            {"name": "So Far Away.flac", "size": 30_000_000},
                            {"name": "Money for Nothing.flac", "size": 48_000_000},
                            {"name": "Walk of Life.flac", "size": 25_000_000},
                            {"name": "Brothers in Arms.flac", "size": 42_000_000},
                        ],
                        "track_count": 4,
                        "total_size": 145_000_000,
                    },
                    {
                        "name": "Dire Straits",
                        "tracks": [
                            {"name": "Sultans of Swing.flac", "size": 35_000_000},
                            {"name": "Down to the Waterline.flac", "size": 28_000_000},
                        ],
                        "track_count": 2,
                        "total_size": 63_000_000,
                    },
                ],
                "total_tracks": 6,
                "total_size": 208_000_000,
            },
            {
                "name": "Fleet Foxes",
                "albums": [
                    {
                        "name": "Fleet Foxes",
                        "tracks": [
                            {"name": "White Winter Hymnal.flac", "size": 3_200_000},
                            {"name": "Ragged Wood.flac", "size": 3_300_000},
                        ],
                        "track_count": 2,
                        "total_size": 6_500_000,
                    },
                ],
                "total_tracks": 2,
                "total_size": 6_500_000,
            },
            {
                "name": "Prince",
                "albums": [
                    {
                        "name": "Purple Rain",
                        "tracks": [
                            {"name": "Let's Go Crazy.flac", "size": 29_000_000},
                            {"name": "Take Me with U.flac", "size": 22_000_000},
                            {"name": "When Doves Cry.flac", "size": 34_000_000},
                            {"name": "Purple Rain.flac", "size": 52_000_000},
                        ],
                        "track_count": 4,
                        "total_size": 137_000_000,
                    },
                    {
                        "name": "Sign o' the Times",
                        "tracks": [
                            {"name": "Sign o' the Times.flac", "size": 28_000_000},
                            {"name": "If I Was Your Girlfriend.flac", "size": 30_000_000},
                        ],
                        "track_count": 2,
                        "total_size": 58_000_000,
                    },
                ],
                "total_tracks": 6,
                "total_size": 195_000_000,
            },
            {
                "name": "The Who",
                "albums": [
                    {
                        "name": "Who's Next",
                        "tracks": [
                            {"name": "Baba O'Riley.flac", "size": 32_000_000},
                        ],
                        "track_count": 1,
                        "total_size": 32_000_000,
                    },
                ],
                "total_tracks": 1,
                "total_size": 32_000_000,
            },
        ],
        "total_size": 630_500_000,
        "total_tracks": 24,
        "capacity_bytes": 20 * 1024 ** 3,  # 20 GB default music image
    }


@router.post("/local/delete")
async def delete_local_music(req: DeleteLocalRequest) -> dict:
    """Delete a path from the local music drive.

    Requires gadget disable, mount rw, delete, unmount, gadget enable.
    In dev mode, just returns success.
    """
    if not req.path:
        raise HTTPException(status_code=400, detail="Path is required")

    if settings.dev_mode:
        return {"message": f"Deleted {req.path} (dev mode)", "deleted": True}

    from backend.services import script_runner
    import os
    import shutil

    mount_point = music_sync.MUSIC_MOUNT
    image_path = music_sync.MUSIC_IMAGE

    # Never touch the image while a sync owns it — rsync is writing it RW, and our
    # mount/umount + gadget toggle would corrupt the transfer. The sync's mount lock
    # only serializes mounts; the job_id check refuses the operation outright.
    if music_sync._active_sync.get("job_id") is not None:
        raise HTTPException(
            status_code=409,
            detail="A music sync is in progress. Try again once it finishes.",
        )

    # Step 1: Disable gadget (required to mount the image read-write)
    result = await script_runner.run(
        "bash", [music_sync.GADGET_DISABLE], timeout=15,
    )
    if result.returncode != 0:
        logger.warning("Gadget disable returned %d (may already be disabled)", result.returncode)

    # Whether the image is confirmed unmounted before the gadget is re-presented.
    # The image must NEVER go back to the car while host-mounted RW (corruption).
    image_released = False
    try:
        # Serialize the mount/umount with music_sync and /api/music/local.
        async with music_sync._image_mount_lock:
            # Re-check: a sync may have started while we waited for the lock.
            if music_sync._active_sync.get("job_id") is not None:
                raise HTTPException(
                    status_code=409,
                    detail="A music sync started. Delete aborted; try again later.",
                )

            # Step 2: Mount rw (skip if already mounted — we release it either way)
            check = await script_runner.run("mountpoint", ["-q", mount_point], timeout=5)
            if check.returncode != 0:
                result = await script_runner.run(
                    "mount", ["-o", "loop", image_path, mount_point], timeout=15,
                )
                if result.returncode != 0:
                    raise HTTPException(status_code=503, detail=f"Failed to mount music image: {result.stderr}")

            try:
                # Step 3: Delete — resolve the target and require it to stay strictly
                # within the mount root (see _safe_delete_target: commonpath, not a
                # string prefix, and root itself is refused).
                target = _safe_delete_target(mount_point, req.path)
                if target is None:
                    raise HTTPException(status_code=400, detail="Invalid path")

                if os.path.isdir(target):
                    loop = asyncio.get_event_loop()
                    await loop.run_in_executor(None, shutil.rmtree, target)
                elif os.path.isfile(target):
                    os.unlink(target)
                else:
                    raise HTTPException(status_code=404, detail="Path not found")

            finally:
                # Step 4: Release the image (verified umount) before leaving the lock.
                image_released = await music_sync._ensure_image_unmounted("delete_local_music")
    finally:
        # Step 5: Re-enable the gadget ONLY if the image is confirmed unmounted.
        if image_released:
            await script_runner.run(
                "bash", [music_sync.GADGET_ENABLE], timeout=15,
            )
        else:
            logger.critical(
                "delete_local_music: music image could not be unmounted; NOT re-enabling "
                "the gadget to avoid corrupting the drive. Manual intervention needed.",
            )

    if not image_released:
        raise HTTPException(
            status_code=500,
            detail="Deleted, but the music image could not be safely unmounted; the drive "
                   "is temporarily offline to the car. Reboot or unmount /mnt/music manually.",
        )

    return {"message": f"Deleted {req.path}", "deleted": True}


# --- Sync endpoints ---


@router.post("/sync")
async def start_sync(req: SyncRequest) -> dict:
    """Start a new sync job.

    Modes:
      - selected: sync specific paths
      - random: sync N random artists/albums
      - recent: sync N most recent items
      - full: sync everything
    """
    paths: list[str] = []
    mode = "selective"

    if req.mode == "selected":
        if not req.paths:
            raise HTTPException(status_code=400, detail="No paths specified for selected sync")
        paths = req.paths
        mode = "selective"

    elif req.mode == "random":
        items = await music_index.get_random(
            settings.database_path, count=req.count, item_type=req.type
        )
        if req.type == "album":
            paths = [f"/{item['artist']}/{item['album']}" for item in items]
        else:
            paths = [f"/{item['artist']}" for item in items]
        mode = "selective"

    elif req.mode == "recent":
        items = await music_index.get_recent(settings.database_path, count=req.count)
        paths = [f"/{item['artist']}/{item['album']}" for item in items]
        mode = "selective"

    elif req.mode == "full":
        mode = "full"

    else:
        raise HTTPException(status_code=400, detail=f"Unknown sync mode: {req.mode}")

    try:
        job_id = await music_sync.start_sync(
            paths=paths,
            mode=mode,
            db_path=settings.database_path,
        )
        return {"job_id": job_id, "status": "pending", "paths_count": len(paths)}
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except Exception as exc:
        logger.error("Failed to start sync: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/sync/status")
async def sync_status() -> dict:
    """Get current/latest sync job status."""
    job = await music_sync.get_sync_status(settings.database_path)
    if not job:
        return {"status": "idle", "job": None}
    return {"status": job.get("status", "unknown"), "job": job}


@router.delete("/sync")
async def cancel_sync() -> dict:
    """Cancel the active sync job."""
    cancelled = await music_sync.cancel_sync(settings.database_path)
    if not cancelled:
        raise HTTPException(status_code=404, detail="No active sync to cancel")
    return {"message": "Sync cancellation requested"}


@router.post("/sync/full")
async def start_full_sync() -> dict:
    """Sync entire remote library to local music drive."""
    try:
        job_id = await music_sync.start_sync(
            paths=[],
            mode="full",
            db_path=settings.database_path,
        )
        return {"job_id": job_id, "status": "pending", "mode": "full"}
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except Exception as exc:
        logger.error("Failed to start full sync: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/sync/new")
async def start_new_sync() -> dict:
    """Sync indexed files that aren't on the Tesla yet.

    "New" means not-yet-synced (music_files.synced = 0) — the correct watermark.
    A file added to the library with an OLD mtime (e.g. ripping an old album) is
    still new-to-Tesla, which a last-sync-timestamp cutoff would miss. The synced
    flag is set by full syncs (whole index) and selective syncs (their files), and
    reset when re-indexing detects a changed file.
    """
    try:
        import aiosqlite
        newer_paths = []
        async with database.connect(settings.database_path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                "SELECT DISTINCT '/' || artist || '/' || album as path "
                "FROM music_files WHERE synced = 0 GROUP BY artist, album"
            ) as cursor:
                async for row in cursor:
                    newer_paths.append(row["path"])

        if not newer_paths:
            return {"job_id": None, "status": "idle", "mode": "new", "note": "No new files to sync"}

        job_id = await music_sync.start_sync(
            paths=newer_paths,
            mode="selective",
            db_path=settings.database_path,
        )
        return {"job_id": job_id, "status": "pending", "mode": "new", "paths_count": len(newer_paths)}

    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except Exception as exc:
        logger.error("Failed to start new sync: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/sync/history")
async def sync_history(
    limit: int = Query(20, ge=1, le=100),
) -> dict:
    """Get past sync jobs."""
    jobs = await music_sync.get_sync_history(settings.database_path, limit=limit)
    return {"jobs": jobs, "count": len(jobs)}
