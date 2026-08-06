"""Dashcam browser and video serving endpoints for TeslaPi."""

import logging
import os
import re
from pathlib import Path, PurePosixPath

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from backend.config import settings
from backend.services import share_browser, dashcam_archive

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/dashcam")

TESLACAM_ROOT = Path("/mnt/cam/TeslaCam")

# Archived clips live on the NAS archive share (written by dashcam_archive to
# <share>/<event_type>/<event_dir>/<clip>), NOT on the cam image — which is unmounted
# while the USB gadget owns it. Serve playback from a dedicated READ-ONLY mount of that
# share so all archived events are viewable (H2/SOL-013). Read-only + a separate
# mountpoint from the archive job's RW /mnt/archive means no interference or corruption.
ARCHIVE_PLAY_MOUNT = "/mnt/archive_play"


def _resolve_media_file(root: Path, rel_path: str) -> Path | None:
    """Resolve a request path under ``root`` for media serving, or None if unsafe.

    Rejects traversal (realpath must stay within root) and non-mp4 targets. Same
    containment discipline as the music-delete guard.
    """
    clean = PurePosixPath(rel_path).as_posix()
    if ".." in clean.split("/"):
        return None
    resolved = (root / clean).resolve()
    try:
        resolved.relative_to(root.resolve())
    except ValueError:
        return None
    if not resolved.name.endswith(".mp4"):
        return None
    return resolved


async def _ensure_archive_mounted() -> Path | None:
    """Ensure the archive share is mounted read-only for playback. Returns its root or None.

    On demand and left mounted (read-only, so it's safe to keep up and makes seeking
    fast). Returns None if the archive share isn't configured or the mount fails, so the
    caller can surface a clear error instead of a bare 404.
    """
    if settings.dev_mode:
        return None
    root = Path(ARCHIVE_PLAY_MOUNT)
    if await share_browser.is_mounted(ARCHIVE_PLAY_MOUNT):
        return root
    cfg = dashcam_archive._get_archive_share_config()
    if not cfg:
        return None
    os.makedirs(ARCHIVE_PLAY_MOUNT, exist_ok=True)
    ok = await share_browser.mount_share(
        share_type=cfg["share_type"],
        server=cfg["server"],
        path=cfg["share_name"],
        mountpoint=ARCHIVE_PLAY_MOUNT,
        username=cfg["username"],
        password=cfg["password"],
        domain=cfg["domain"],
        read_only=True,
    )
    return root if ok else None

# Map subfolder names to event types
_TYPE_MAP = {
    "SentryClips": "sentry",
    "SavedClips": "saved",
    "RecentClips": "recent",
    "TrackMode": "track",
}

CAMERA_NAMES = ["front", "back", "left_repeater", "right_repeater", "left_pillar", "right_pillar"]

# Pattern: 2025-07-04_14-30-22
_TIMESTAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$")
# Pattern: 2025-07-04_14-30-22-front.mp4
_CLIP_FILE_RE = re.compile(r"^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})-(\w+)\.mp4$")


class ClipResponse(BaseModel):
    timestamp: str
    cameras: dict[str, str]
    duration: float | None = None


class EventResponse(BaseModel):
    id: str
    type: str
    timestamp: str
    cameras: list[str]
    archived: bool


class EventDetailResponse(BaseModel):
    id: str
    type: str
    timestamp: str
    clips: list[ClipResponse]
    totalDuration: float
    archived: bool


# --- Mock data for dev mode ---

def _mock_events() -> list[EventResponse]:
    return [
        EventResponse(
            id="sentry__2026-04-09_14-30-22",
            type="sentry",
            timestamp="2026-04-09T14:30:22",
            cameras=["front", "left_repeater", "right_repeater", "back"],
            archived=False,
        ),
        EventResponse(
            id="saved__2026-04-09_08-15-00",
            type="saved",
            timestamp="2026-04-09T08:15:00",
            cameras=["front", "left_repeater", "right_repeater", "left_pillar", "right_pillar", "back"],
            archived=True,
        ),
        EventResponse(
            id="sentry__2026-04-08_22-45-10",
            type="sentry",
            timestamp="2026-04-08T22:45:10",
            cameras=["front", "left_repeater", "right_repeater", "back"],
            archived=True,
        ),
        EventResponse(
            id="recent__2026-04-08_16-20-33",
            type="recent",
            timestamp="2026-04-08T16:20:33",
            cameras=["front", "left_repeater", "right_repeater"],
            archived=False,
        ),
        EventResponse(
            id="track__2026-04-07_10-05-44",
            type="track",
            timestamp="2026-04-07T10:05:44",
            cameras=["front", "left_repeater", "right_repeater", "left_pillar", "right_pillar", "back"],
            archived=False,
        ),
        EventResponse(
            id="saved__2026-04-06_19-30-00",
            type="saved",
            timestamp="2026-04-06T19:30:00",
            cameras=["front", "back", "left_repeater", "right_repeater"],
            archived=True,
        ),
    ]


def _mock_event_detail(event_id: str) -> EventDetailResponse | None:
    events = _mock_events()
    ev = next((e for e in events if e.id == event_id), None)
    if ev is None:
        return None

    # Generate 3 clips per event to simulate multi-segment events
    clips = []
    base_ts = ev.timestamp.replace("T", "_").replace(":", "-")
    for i in range(3):
        minute_offset = i
        ts_parts = base_ts.rsplit("-", 1)
        sec = int(ts_parts[-1]) if len(ts_parts) > 1 else 0
        clip_ts = f"{ts_parts[0]}-{sec + minute_offset:02d}" if len(ts_parts) > 1 else base_ts

        cameras: dict[str, str] = {}
        for cam in ev.cameras:
            cameras[cam] = f"/api/dashcam/video/mock/{event_id}/{clip_ts}-{cam}.mp4"

        clips.append(ClipResponse(
            timestamp=clip_ts,
            cameras=cameras,
            duration=60.0,
        ))

    return EventDetailResponse(
        id=ev.id,
        type=ev.type,
        timestamp=ev.timestamp,
        clips=clips,
        totalDuration=60.0 * len(clips),
        archived=ev.archived,
    )


# --- Filesystem scanning ---

def _scan_events(type_filter: str | None = None) -> list[EventResponse]:
    """Scan TeslaCam directories for events."""
    events: list[EventResponse] = []

    for subfolder, event_type in _TYPE_MAP.items():
        if type_filter and event_type != type_filter:
            continue

        folder = TESLACAM_ROOT / subfolder
        if not folder.is_dir():
            continue

        for event_dir in sorted(folder.iterdir(), reverse=True):
            if not event_dir.is_dir():
                continue
            if not _TIMESTAMP_RE.match(event_dir.name):
                continue

            # Find available cameras
            cameras = set()
            for f in event_dir.iterdir():
                m = _CLIP_FILE_RE.match(f.name)
                if m:
                    cameras.add(m.group(2))

            if not cameras:
                continue

            event_id = f"{event_type}__{event_dir.name}"
            timestamp = event_dir.name.replace("_", "T", 1).replace("-", ":", 3)
            # Fix: the timestamp format needs proper conversion
            # 2025-07-04_14-30-22 -> 2025-07-04T14:30:22
            ts_raw = event_dir.name
            ts_date = ts_raw[:10]
            ts_time = ts_raw[11:].replace("-", ":")
            timestamp = f"{ts_date}T{ts_time}"

            events.append(EventResponse(
                id=event_id,
                type=event_type,
                timestamp=timestamp,
                cameras=sorted(cameras),
                archived=False,  # Could check for a marker file
            ))

    events.sort(key=lambda e: e.timestamp, reverse=True)
    return events


def _get_event_detail(event_id: str) -> EventDetailResponse | None:
    """Load detailed event info by scanning clip files."""
    parts = event_id.split("__", 1)
    if len(parts) != 2:
        return None

    event_type, dir_name = parts

    # Find which subfolder
    subfolder = None
    for sf, et in _TYPE_MAP.items():
        if et == event_type:
            subfolder = sf
            break
    if not subfolder:
        return None

    event_dir = TESLACAM_ROOT / subfolder / dir_name
    if not event_dir.is_dir():
        return None

    # Group files by timestamp to identify separate clips
    clip_map: dict[str, dict[str, str]] = {}
    for f in sorted(event_dir.iterdir()):
        m = _CLIP_FILE_RE.match(f.name)
        if not m:
            continue
        clip_ts = m.group(1)
        camera = m.group(2)
        if clip_ts not in clip_map:
            clip_map[clip_ts] = {}
        clip_map[clip_ts][camera] = f"/api/dashcam/video/{subfolder}/{dir_name}/{f.name}"

    clips = []
    for ts in sorted(clip_map.keys()):
        clips.append(ClipResponse(
            timestamp=ts,
            cameras=clip_map[ts],
            duration=60.0,  # Approximate; could probe with ffprobe
        ))

    if not clips:
        return None

    ts_date = dir_name[:10]
    ts_time = dir_name[11:].replace("-", ":")
    timestamp = f"{ts_date}T{ts_time}"

    all_cameras = set()
    for c in clips:
        all_cameras.update(c.cameras.keys())

    return EventDetailResponse(
        id=event_id,
        type=event_type,
        timestamp=timestamp,
        clips=clips,
        totalDuration=60.0 * len(clips),
        archived=False,
    )


async def _get_event_detail_from_db(event_id: str) -> EventDetailResponse | None:
    """Load event detail from the archived-clips DB.

    The cam image is unmounted while the USB gadget owns it, so the old path that
    scanned /mnt/cam 404'd for every event (H2/SOL-013). Read the same
    dashcam_archived_clips table that list_events uses, grouping clips by timestamp
    into per-camera URLs.
    """
    import aiosqlite

    parts = event_id.split("__", 1)
    if len(parts) != 2:
        return None
    display_type, event_dir = parts
    db_type = (
        "SentryClips" if display_type == "sentry"
        else "SavedClips" if display_type == "saved"
        else display_type
    )

    rows: list[dict] = []
    try:
        async with aiosqlite.connect(str(settings.database_path)) as db:
            db.row_factory = aiosqlite.Row
            await db.execute("PRAGMA journal_mode=WAL")
            async with db.execute(
                "SELECT clip_file FROM dashcam_archived_clips "
                "WHERE event_dir = ? AND event_type = ? ORDER BY clip_file",
                (event_dir, db_type),
            ) as cursor:
                rows = [dict(r) async for r in cursor]
    except Exception as exc:
        logger.error("Failed to read event detail from DB: %s", exc)
        return None

    if not rows:
        return None

    # Group clips by timestamp; each timestamp maps camera -> video URL.
    clip_map: dict[str, dict[str, str]] = {}
    for row in rows:
        clip_file = row.get("clip_file") or ""
        m = _CLIP_FILE_RE.match(clip_file)
        if not m:
            continue
        clip_ts, camera = m.group(1), m.group(2)
        clip_map.setdefault(clip_ts, {})[camera] = (
            f"/api/dashcam/video/{db_type}/{event_dir}/{clip_file}"
        )

    clips = [
        ClipResponse(timestamp=ts, cameras=clip_map[ts], duration=60.0)
        for ts in sorted(clip_map.keys())
    ]
    if not clips:
        return None

    ts_date = event_dir[:10] if len(event_dir) >= 10 else event_dir
    ts_time = event_dir[11:].replace("-", ":") if len(event_dir) > 11 else "00:00:00"

    return EventDetailResponse(
        id=event_id,
        type=display_type,
        timestamp=f"{ts_date}T{ts_time}",
        clips=clips,
        totalDuration=60.0 * len(clips),
        archived=True,
    )


# --- Routes ---

@router.get("/events", response_model=list[EventResponse])
async def list_events(type: str | None = None) -> list[EventResponse]:
    """List all dashcam events from the archived clips database.

    Since the cam image cannot be mounted while the USB gadget is active,
    we read from the dashcam_archived_clips DB table which tracks all
    clips that have been archived to the NAS.

    In dev mode, returns mock data.
    """
    if settings.dev_mode:
        events = _mock_events()
        if type:
            events = [e for e in events if e.type == type]
        return events

    # Read from DB instead of filesystem
    import aiosqlite
    db_path = str(settings.database_path)
    events: list[EventResponse] = []

    try:
        async with aiosqlite.connect(db_path) as db:
            db.row_factory = aiosqlite.Row
            await db.execute("PRAGMA journal_mode=WAL")

            query = """SELECT event_type, event_dir,
                              GROUP_CONCAT(clip_file) as clip_files,
                              COUNT(*) as clip_count,
                              MAX(archived_at) as archived_at
                       FROM dashcam_archived_clips"""
            params: list = []
            if type:
                # Map frontend types to DB types
                db_type = "SentryClips" if type == "sentry" else "SavedClips" if type == "saved" else type
                query += " WHERE event_type = ?"
                params.append(db_type)
            query += " GROUP BY event_type, event_dir ORDER BY event_dir DESC LIMIT 50"

            async with db.execute(query, params) as cursor:
                async for row in cursor:
                    event = dict(row)
                    event_type = event.get("event_type", "")
                    event_dir = event.get("event_dir", "")
                    display_type = "sentry" if "sentry" in event_type.lower() else "saved"

                    # Extract cameras from clip filenames
                    cameras = []
                    for clip_file in (event.get("clip_files", "") or "").split(","):
                        parts = clip_file.rsplit("-", 1)
                        if len(parts) == 2:
                            cam = parts[1].replace(".mp4", "").strip()
                            if cam and cam not in cameras:
                                cameras.append(cam)

                    # Parse timestamp from event_dir (2026-04-12_10-00-02)
                    ts_date = event_dir[:10] if len(event_dir) >= 10 else event_dir
                    ts_time = event_dir[11:].replace("-", ":") if len(event_dir) > 11 else "00:00:00"
                    timestamp = f"{ts_date}T{ts_time}"

                    events.append(EventResponse(
                        id=f"{display_type}__{event_dir}",
                        type=display_type,
                        timestamp=timestamp,
                        cameras=sorted(cameras),
                        archived=True,
                    ))
    except Exception as exc:
        logger.error("Failed to read dashcam events from DB: %s", exc)
        # Fall back to filesystem scan if DB fails
        return _scan_events(type_filter=type)

    return events


@router.get("/events/{event_id}", response_model=EventDetailResponse)
async def get_event(event_id: str) -> EventDetailResponse:
    """Get detailed event info including all clips and camera URLs.

    Returns clip-level detail with video URLs for each camera angle.
    """
    if settings.dev_mode:
        detail = _mock_event_detail(event_id)
        if detail is None:
            raise HTTPException(status_code=404, detail="Event not found")
        return detail

    detail = await _get_event_detail_from_db(event_id)
    if detail is None:
        raise HTTPException(status_code=404, detail="Event not found")
    return detail


@router.get("/video/{path:path}")
async def serve_video(request: Request, path: str):
    """Serve a dashcam video file with Range header support for seeking.

    Supports HTTP Range requests for efficient video seeking without
    downloading the entire file.
    """
    if settings.dev_mode:
        # In dev mode, return a 204 with appropriate headers so the UI doesn't break
        raise HTTPException(
            status_code=501,
            detail="Video serving not available in dev mode. Use real TeslaCam files on the Pi.",
        )

    if ".." in PurePosixPath(path).as_posix():
        raise HTTPException(status_code=403, detail="Path traversal not allowed")

    # Archived clips live on the NAS archive share; serve from a read-only mount of it.
    # Fall back to the live cam image only if it happens to be mounted (gadget down).
    file_resolved: Path | None = None
    archive_root = await _ensure_archive_mounted()
    if archive_root is not None:
        candidate = _resolve_media_file(archive_root, path)
        if candidate is not None and candidate.is_file():
            file_resolved = candidate

    if file_resolved is None and TESLACAM_ROOT.exists():
        candidate = _resolve_media_file(TESLACAM_ROOT, path)
        if candidate is not None and candidate.is_file():
            file_resolved = candidate

    if file_resolved is None:
        # Distinguish "can't reach the archive" from "clip genuinely missing".
        if archive_root is None:
            raise HTTPException(
                status_code=503,
                detail="Archive share not reachable — cannot stream archived clips.",
            )
        raise HTTPException(status_code=404, detail="Video file not found")

    file_size = file_resolved.stat().st_size
    range_header = request.headers.get("range")

    if range_header:
        # Parse Range: bytes=start-end
        range_match = re.match(r"bytes=(\d+)-(\d*)", range_header)
        if not range_match:
            raise HTTPException(status_code=416, detail="Invalid range")

        start = int(range_match.group(1))
        end = int(range_match.group(2)) if range_match.group(2) else file_size - 1
        end = min(end, file_size - 1)

        if start >= file_size:
            raise HTTPException(status_code=416, detail="Range not satisfiable")

        chunk_size = end - start + 1

        def iter_file():
            with open(file_resolved, "rb") as f:
                f.seek(start)
                remaining = chunk_size
                while remaining > 0:
                    read_size = min(remaining, 1024 * 1024)  # 1MB chunks
                    data = f.read(read_size)
                    if not data:
                        break
                    remaining -= len(data)
                    yield data

        return StreamingResponse(
            iter_file(),
            status_code=206,
            media_type="video/mp4",
            headers={
                "Content-Range": f"bytes {start}-{end}/{file_size}",
                "Accept-Ranges": "bytes",
                "Content-Length": str(chunk_size),
                "Cache-Control": "public, max-age=86400",
            },
        )

    # No range header: serve entire file
    return FileResponse(
        str(file_resolved),
        media_type="video/mp4",
        headers={
            "Accept-Ranges": "bytes",
            "Cache-Control": "public, max-age=86400",
        },
    )
