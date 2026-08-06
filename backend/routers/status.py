"""Status endpoint returning full TeslaPi system state."""

import logging
from datetime import datetime, timezone

import aiosqlite
from fastapi import APIRouter

from backend.config import settings
from backend.models.schemas import (
    ArchiveStatus,
    DashcamEvent,
    GadgetStatus,
    MusicSyncStatus,
    StorageInfo,
    SystemState,
    SystemStatus,
    TeslaPiStatus,
)
from backend.services import dashcam_archive
from backend.services import script_runner

logger = logging.getLogger(__name__)
router = APIRouter()


def _parse_db_timestamp(value) -> datetime | None:
    """Coerce a DB timestamp into a datetime for datetime-typed response fields.

    SQLite hands back TIMESTAMP columns as strings in two shapes: 'CURRENT_TIMESTAMP'
    writes '2026-08-06 16:23:55' (space, naive) while Python-written ISO values look
    like '2026-08-06T16:22:28.104994+00:00'. Assigning either raw string to a
    `datetime`-typed pydantic field produces a serialization-mismatch warning AND
    breaks consumers that call `.isoformat()` on it (e.g. the HA push loop). Parse
    both forms here; pass through an existing datetime; return None on anything
    unparseable rather than raising.
    """
    if value is None or isinstance(value, datetime):
        return value
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace(" ", "T", 1))
        except ValueError:
            logger.debug("Unparseable DB timestamp: %r", value)
            return None
    return None


def _mock_status() -> TeslaPiStatus:
    """Return realistic mock data for dev mode."""
    return TeslaPiStatus(
        state=SystemState.IDLE,
        system=SystemStatus(
            hostname="teslapi-dev",
            os_version="Raspberry Pi OS 12 (bookworm)",
            teslausb_version="2024.44.25",
            uptime_seconds=345600,
            cpu_temp_celsius=38.2,
            cpu_usage=12.5,
            ram_used_bytes=432_013_312,
            ram_total_bytes=4_147_483_648,
            wifi_ssid="HomeWiFi",
            wifi_signal_dbm=-42,
            ip_address="192.168.1.50",
        ),
        storage=[
            StorageInfo(
                total_bytes=150_323_855_360,
                used_bytes=112_742_891_520,
                free_bytes=37_580_963_840,
                percent_used=75.0,
                mount_point="/mnt/cam",
                label="Dashcam",
            ),
            StorageInfo(
                total_bytes=1_932_735_283_200,
                used_bytes=1_759_218_604_032,
                free_bytes=173_516_679_168,
                percent_used=91.0,
                mount_point="/mnt/music",
                label="Music",
            ),
            StorageInfo(
                total_bytes=2_000_398_934_016,
                used_bytes=1_900_378_987_315,
                free_bytes=100_019_946_701,
                percent_used=95.0,
                mount_point="/mnt/usb",
                label="External Drive",
            ),
        ],
        gadget=GadgetStatus(
            enabled=True,
            state="connected",
            drives=["cam", "music", "lightshow", "boombox"],
        ),
        dashcam=[
            DashcamEvent(
                timestamp=datetime(2026, 4, 9, 14, 34, 0, tzinfo=timezone.utc),
                type="sentry",
                path="/TeslaCam/SentryClips/2026-04-09_14-34-00",
                size_bytes=524_288_000,
                cameras=["front", "back", "left_repeater", "right_repeater", "left_pillar", "right_pillar"],
            ),
            DashcamEvent(
                timestamp=datetime(2026, 4, 9, 11, 15, 0, tzinfo=timezone.utc),
                type="saved",
                path="/TeslaCam/SavedClips/2026-04-09_11-15-00",
                size_bytes=1_073_741_824,
                cameras=["front", "back", "left_repeater", "right_repeater", "left_pillar", "right_pillar"],
            ),
            DashcamEvent(
                timestamp=datetime(2026, 4, 8, 21, 42, 0, tzinfo=timezone.utc),
                type="sentry",
                path="/TeslaCam/SentryClips/2026-04-08_21-42-00",
                size_bytes=262_144_000,
                cameras=["front", "back", "left_repeater", "right_repeater", "left_pillar", "right_pillar"],
            ),
        ],
        archive=ArchiveStatus(
            server_reachable=True,
            last_archive_at=datetime(2026, 4, 9, 6, 0, 0, tzinfo=timezone.utc),
            last_archive_clips=47,
            last_archive_bytes=13_207_024_640,
            next_archive="waiting for idle",
        ),
        music=MusicSyncStatus(
            total_artists=847,
            total_tracks=12_483,
            last_sync_at=datetime(2026, 4, 8, 3, 0, 0, tzinfo=timezone.utc),
            sync_in_progress=False,
        ),
        timestamp=datetime.now(timezone.utc),
    )


# Previous /proc/stat sample (total, idle jiffies) for computing CPU usage as a
# delta across status polls — avoids blocking the request with a sleep.
_prev_cpu_sample: tuple[int, int] | None = None


async def _read_cpu_usage() -> float:
    """CPU usage percent, computed from the delta between successive /proc/stat
    reads. Returns 0.0 on the first call (no baseline) or if /proc/stat is
    unreadable — never raises."""
    global _prev_cpu_sample
    result = await script_runner.run("cat", ["/proc/stat"], timeout=5)
    if result.returncode != 0 or not result.stdout:
        return 0.0
    line = result.stdout.splitlines()[0]
    parts = line.split()
    if len(parts) < 5 or parts[0] != "cpu":
        return 0.0
    try:
        nums = [int(x) for x in parts[1:]]
    except ValueError:
        return 0.0
    total = sum(nums)
    idle = nums[3] + (nums[4] if len(nums) > 4 else 0)  # idle + iowait

    prev = _prev_cpu_sample
    _prev_cpu_sample = (total, idle)
    if prev is None:
        return 0.0
    total_delta = total - prev[0]
    idle_delta = idle - prev[1]
    if total_delta <= 0:
        return 0.0
    usage = 100.0 * (total_delta - idle_delta) / total_delta
    return round(max(0.0, min(100.0, usage)), 1)


async def _read_system_info() -> SystemStatus:
    """Gather system info from /proc and standard tools."""
    info = SystemStatus()

    # Hostname
    result = await script_runner.run("hostname", timeout=5)
    if result.returncode == 0:
        info.hostname = result.stdout.strip()

    # OS version
    result = await script_runner.run("cat", ["/etc/os-release"], timeout=5)
    if result.returncode == 0:
        for line in result.stdout.splitlines():
            if line.startswith("PRETTY_NAME="):
                info.os_version = line.split("=", 1)[1].strip('"')
                break

    # Uptime
    result = await script_runner.run("cat", ["/proc/uptime"], timeout=5)
    if result.returncode == 0:
        try:
            info.uptime_seconds = int(float(result.stdout.split()[0]))
        except (ValueError, IndexError):
            pass

    # CPU temperature
    result = await script_runner.run(
        "cat", ["/sys/class/thermal/thermal_zone0/temp"], timeout=5
    )
    if result.returncode == 0:
        try:
            info.cpu_temp_celsius = int(result.stdout) / 1000.0
        except ValueError:
            pass

    # RAM
    result = await script_runner.run("cat", ["/proc/meminfo"], timeout=5)
    if result.returncode == 0:
        for line in result.stdout.splitlines():
            if line.startswith("MemTotal:"):
                info.ram_total_bytes = int(line.split()[1]) * 1024
            elif line.startswith("MemAvailable:"):
                avail = int(line.split()[1]) * 1024
                info.ram_used_bytes = info.ram_total_bytes - avail

    # CPU usage (delta across polls)
    info.cpu_usage = await _read_cpu_usage()

    # WiFi
    result = await script_runner.run("iwgetid", ["-r"], timeout=5)
    if result.returncode == 0:
        info.wifi_ssid = result.stdout.strip()

    result = await script_runner.run(
        "bash", ["-c", "iwconfig wlan0 2>/dev/null | grep -o 'Signal level=.*' | grep -o '[-0-9]*'"],
        timeout=5,
    )
    if result.returncode == 0 and result.stdout:
        try:
            info.wifi_signal_dbm = int(result.stdout.splitlines()[0])
        except ValueError:
            pass

    # IP address
    result = await script_runner.run(
        "bash", ["-c", "hostname -I | awk '{print $1}'"], timeout=5
    )
    if result.returncode == 0:
        info.ip_address = result.stdout.strip()

    return info


async def _read_storage() -> list[StorageInfo]:
    """Read storage info from mounted filesystems or backing files.

    First checks ``df`` for mounted drives.  For any known drive that is
    *not* mounted (common when the USB gadget owns the image), we fall
    back to reporting the backing file size from ``/backingfiles/``.
    """
    storages: list[StorageInfo] = []

    # Map of mount point -> (label, backing-file path)
    drive_map: dict[str, tuple[str, str]] = {
        "/mnt/cam": ("Dashcam", "/backingfiles/cam_disk.bin"),
        "/mnt/music": ("Music", "/backingfiles/music_disk.bin"),
        "/mnt/lightshow": ("Lightshow", "/backingfiles/lightshow_disk.bin"),
        "/mnt/boombox": ("Boombox", "/backingfiles/boombox_disk.bin"),
    }

    # Collect mounted info via df
    mounted_info: dict[str, StorageInfo] = {}
    result = await script_runner.run(
        "df", ["--output=target,size,used,avail,pcent", "-B1"], timeout=10
    )
    if result.returncode == 0:
        for line in result.stdout.splitlines()[1:]:  # skip header
            parts = line.split()
            if len(parts) < 5:
                continue
            mount = parts[0]
            if mount in drive_map:
                label, _ = drive_map[mount]
                try:
                    mounted_info[mount] = StorageInfo(
                        total_bytes=int(parts[1]),
                        used_bytes=int(parts[2]),
                        free_bytes=int(parts[3]),
                        percent_used=float(parts[4].rstrip("%")),
                        mount_point=mount,
                        label=label,
                    )
                except (ValueError, IndexError):
                    logger.warning("Failed to parse df output for %s", mount)

    # Build final list — use df data if mounted, otherwise backing-file size
    import os

    for mount, (label, backing_file) in drive_map.items():
        if mount in mounted_info:
            storages.append(mounted_info[mount])
        elif os.path.isfile(backing_file):
            try:
                st = os.stat(backing_file)
                file_size = st.st_size  # Apparent size (total capacity)
                disk_usage = st.st_blocks * 512  # Actual disk blocks used
            except OSError:
                file_size = 0
                disk_usage = 0
            storages.append(StorageInfo(
                total_bytes=file_size,
                used_bytes=disk_usage,
                free_bytes=max(0, file_size - disk_usage),
                percent_used=round((disk_usage / file_size * 100) if file_size > 0 else 0, 1),
                mount_point=mount,
                label=label,
            ))

    return storages


async def _read_gadget_status() -> GadgetStatus:
    """Read USB gadget status from sysfs."""
    status = GadgetStatus()

    result = await script_runner.run(
        "bash",
        ["-c", "ls /sys/kernel/config/usb_gadget/ 2>/dev/null"],
        timeout=5,
    )
    if result.returncode == 0 and result.stdout:
        status.enabled = True
        status.state = "active"

    result = await script_runner.run(
        "bash",
        ["-c", "ls /sys/kernel/config/usb_gadget/*/functions/ 2>/dev/null"],
        timeout=5,
    )
    if result.returncode == 0:
        for line in result.stdout.splitlines():
            name = line.strip().rstrip("/")
            if name:
                status.drives.append(name)

    return status


async def _read_music_status() -> MusicSyncStatus:
    """Read music sync status from the database."""
    db_path = str(settings.database_path)
    music = MusicSyncStatus()

    try:
        async with aiosqlite.connect(db_path) as db:
            db.row_factory = aiosqlite.Row
            await db.execute("PRAGMA journal_mode=WAL")

            # Count synced artists from music_files table
            async with db.execute(
                "SELECT COUNT(DISTINCT artist) as cnt FROM music_files WHERE synced = 1"
            ) as cursor:
                row = await cursor.fetchone()
                if row:
                    music.total_artists = row["cnt"]

            # Total tracks synced
            async with db.execute(
                "SELECT COUNT(*) as cnt FROM music_files WHERE synced = 1"
            ) as cursor:
                row = await cursor.fetchone()
                if row:
                    music.total_tracks = row["cnt"]

            # Latest sync job
            async with db.execute(
                "SELECT * FROM music_sync_jobs ORDER BY id DESC LIMIT 1"
            ) as cursor:
                row = await cursor.fetchone()
                if row:
                    job = dict(row)
                    if job.get("status") == "running":
                        music.sync_in_progress = True
                        music.current_job_id = job.get("id")
                    if job.get("completed_at"):
                        music.last_sync_at = job["completed_at"]
    except Exception as exc:
        logger.warning("Failed to read music status: %s", exc)

    return music


async def _read_dashcam_events() -> list[DashcamEvent]:
    """Read recent dashcam events from the archived clips database.

    Since the cam image cannot be mounted while the gadget is active,
    we show the most recent archived clips from the DB instead.
    """
    db_path = str(settings.database_path)
    events: list[DashcamEvent] = []

    try:
        async with aiosqlite.connect(db_path) as db:
            db.row_factory = aiosqlite.Row
            await db.execute("PRAGMA journal_mode=WAL")

            # Group clips by event (event_type + event_dir)
            async with db.execute(
                """SELECT event_type, event_dir,
                          GROUP_CONCAT(clip_file) as clip_files,
                          COUNT(*) as clip_count,
                          SUM(size_bytes) as total_size,
                          MAX(archived_at) as archived_at
                   FROM dashcam_archived_clips
                   GROUP BY event_type, event_dir
                   ORDER BY archived_at DESC
                   LIMIT 10"""
            ) as cursor:
                async for row in cursor:
                    event = dict(row)
                    # Extract camera names from clip filenames
                    # e.g., "2026-04-12_09-57-58-front.mp4" → "front"
                    cameras = []
                    for clip_file in (event.get("clip_files", "") or "").split(","):
                        parts = clip_file.rsplit("-", 1)
                        if len(parts) == 2:
                            cam = parts[1].replace(".mp4", "").strip()
                            if cam and cam not in cameras:
                                cameras.append(cam)

                    event_type = event.get("event_type", "saved")
                    # Map DB types to display types
                    display_type = "sentry" if "sentry" in event_type.lower() else "saved"

                    events.append(DashcamEvent(
                        timestamp=event.get("archived_at"),
                        type=display_type,
                        path=f"/TeslaCam/{event_type}/{event.get('event_dir', '')}",
                        size_bytes=event.get("total_size", 0),
                        cameras=cameras,
                    ))
    except Exception as exc:
        logger.warning("Failed to read dashcam events: %s", exc)

    return events


def _determine_system_state(
    archive_data: dict,
    music: MusicSyncStatus,
    gadget: GadgetStatus,
) -> SystemState:
    """Determine the overall system state from sub-statuses.

    Priority: an active operation (archiving/syncing) is reported first because it's
    what's happening right now; then a recent failure (ERROR); then CONNECTED when the
    USB gadget is presented to the car but idle; else IDLE. OFFLINE is intentionally
    NOT emitted here — if this endpoint is responding the Pi is online; the dashboard
    owns OFFLINE for when the API itself is unreachable.
    """
    latest_job = archive_data.get("latest_job")
    job_status = latest_job.get("status") if latest_job else None

    if job_status == "running":
        return SystemState.ARCHIVING
    if music.sync_in_progress:
        return SystemState.SYNCING
    if job_status == "failed":
        return SystemState.ERROR
    if gadget.enabled:
        return SystemState.CONNECTED
    return SystemState.IDLE


@router.get("/status", response_model=TeslaPiStatus)
async def get_status() -> TeslaPiStatus:
    """Return full system status.

    In dev mode, returns mock data. In production, gathers real data
    from sysfs and proc.
    """
    if settings.dev_mode:
        return _mock_status()

    # Gather status from sysfs/proc/DB. (There is no run/status.sh — an earlier
    # "try the script first" probe spawned bash on every request only to fail and
    # fall through here, so it was removed.)
    system = await _read_system_info()
    storage = await _read_storage()
    gadget = await _read_gadget_status()

    # Populate archive status from DB (live data, not stale)
    archive_data = await dashcam_archive.get_archive_status()
    archive = ArchiveStatus(
        server_reachable=archive_data.get("server_reachable", False),
        server_name=archive_data.get("server_name", ""),
    )
    latest_job = archive_data.get("latest_job")
    if latest_job:
        if latest_job.get("completed_at"):
            archive.last_archive_at = _parse_db_timestamp(latest_job["completed_at"])
        archive.last_archive_clips = archive_data.get("total_clips", 0)
        archive.last_archive_bytes = archive_data.get("total_bytes", 0)

    # Music status from DB
    music = await _read_music_status()

    # Dashcam events from archived clips DB
    dashcam_events = await _read_dashcam_events()

    # Determine overall state
    state = _determine_system_state(archive_data, music, gadget)

    return TeslaPiStatus(
        state=state,
        system=system,
        storage=storage,
        gadget=gadget,
        dashcam=dashcam_events,
        archive=archive,
        music=music,
        timestamp=datetime.now(timezone.utc),
    )
