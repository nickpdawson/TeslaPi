"""USB gadget control endpoints."""

import logging

from fastapi import APIRouter, HTTPException

from backend.config import settings
from backend.models.schemas import DriveInfo, GadgetStatus, GadgetToggleRequest
from backend.services import script_runner

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/gadget")

# The gadget enable/disable scripts that the sync/customization paths use and that
# build.sh + install.sh actually install under /opt/teslapi/deploy. The old relative
# "run/enable_gadget.sh" managed the inherited teslausb gadget and was never installed,
# so /gadget/toggle failed 100% on a real device — unify on the installed scripts.
GADGET_ENABLE = "/opt/teslapi/deploy/teslapi-gadget-enable.sh"
GADGET_DISABLE = "/opt/teslapi/deploy/teslapi-gadget-disable.sh"


@router.get("/status", response_model=GadgetStatus)
async def get_gadget_status() -> GadgetStatus:
    """Return current USB gadget state."""
    if settings.dev_mode:
        return GadgetStatus(
            enabled=True,
            state="connected",
            drives=["cam", "music", "lightshow", "boombox"],
        )

    status = GadgetStatus()

    # Check if gadget directory exists
    result = await script_runner.run(
        "bash",
        ["-c", "ls /sys/kernel/config/usb_gadget/ 2>/dev/null"],
        timeout=5,
    )
    if result.returncode == 0 and result.stdout.strip():
        status.enabled = True
        status.state = "active"
    else:
        status.state = "disabled"

    # List configured functions (drive types)
    result = await script_runner.run(
        "bash",
        ["-c", "ls -d /sys/kernel/config/usb_gadget/*/functions/mass_storage.* 2>/dev/null | xargs -I{} basename {}"],
        timeout=5,
    )
    if result.returncode == 0 and result.stdout.strip():
        for line in result.stdout.splitlines():
            name = line.strip().replace("mass_storage.", "")
            if name:
                status.drives.append(name)

    return status


@router.post("/toggle", response_model=GadgetStatus)
async def toggle_gadget(request: GadgetToggleRequest) -> GadgetStatus:
    """Enable or disable the USB gadget."""
    if settings.dev_mode:
        return GadgetStatus(
            enabled=request.enabled,
            state="active" if request.enabled else "disabled",
            drives=["cam", "music", "lightshow", "boombox"] if request.enabled else [],
        )

    script = GADGET_ENABLE if request.enabled else GADGET_DISABLE
    action = "enable" if request.enabled else "disable"

    logger.info("Toggling USB gadget: %s", action)
    result = await script_runner.run("bash", [script], timeout=30)

    if result.returncode != 0:
        logger.error("Failed to %s gadget: %s", action, result.stderr)
        raise HTTPException(
            status_code=500,
            detail=f"Failed to {action} USB gadget: {result.stderr}",
        )

    # Return fresh status after toggle
    return await get_gadget_status()


@router.get("/drives", response_model=list[DriveInfo])
async def list_drives() -> list[DriveInfo]:
    """List configured USB gadget drives (cam, music, lightshow, boombox)."""
    if settings.dev_mode:
        return [
            DriveInfo(name="cam", path="/mnt/cam", size_bytes=150_323_855_360, type="dashcam"),
            DriveInfo(name="music", path="/mnt/music", size_bytes=1_932_735_283_200, type="music"),
            DriveInfo(name="lightshow", path="/mnt/lightshow", size_bytes=1_073_741_824, type="lightshow"),
            DriveInfo(name="boombox", path="/mnt/boombox", size_bytes=1_073_741_824, type="boombox"),
        ]

    drives: list[DriveInfo] = []
    known_drives = {
        "cam": ("/mnt/cam", "dashcam"),
        "music": ("/mnt/music", "music"),
        "lightshow": ("/mnt/lightshow", "lightshow"),
        "boombox": ("/mnt/boombox", "boombox"),
    }

    for name, (mount, drive_type) in known_drives.items():
        result = await script_runner.run(
            "bash",
            ["-c", f"df --output=size -B1 {mount} 2>/dev/null | tail -1"],
            timeout=5,
        )
        size = 0
        if result.returncode == 0 and result.stdout.strip():
            try:
                size = int(result.stdout.strip())
            except ValueError:
                pass

        drives.append(DriveInfo(
            name=name,
            path=mount,
            size_bytes=size,
            type=drive_type,
        ))

    return drives
