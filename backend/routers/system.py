"""System management endpoints."""

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException

from backend.config import settings
from backend.models.schemas import ApiError, RebootRequest
from backend.services import script_runner

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/system")


@router.get("/info")
async def get_system_info() -> dict:
    """Return hostname, OS version, teslausb version, and uptime."""
    if settings.dev_mode:
        return {
            "hostname": "teslapi-dev",
            "os_version": "Raspberry Pi OS 12 (bookworm)",
            "teslausb_version": "2024.44.25",
            "uptime": "4 days, 0:00:00",
            "uptime_seconds": 345600,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }

    info: dict[str, str | int] = {}

    result = await script_runner.run("hostname", timeout=5)
    info["hostname"] = result.stdout if result.returncode == 0 else "unknown"

    result = await script_runner.run("cat", ["/etc/os-release"], timeout=5)
    info["os_version"] = ""
    if result.returncode == 0:
        for line in result.stdout.splitlines():
            if line.startswith("PRETTY_NAME="):
                info["os_version"] = line.split("=", 1)[1].strip('"')
                break

    # Try to read teslausb version from the version file or git
    result = await script_runner.run(
        "bash", ["-c", "cat /etc/teslausb_version 2>/dev/null || echo unknown"],
        timeout=5,
    )
    info["teslausb_version"] = result.stdout if result.returncode == 0 else "unknown"

    result = await script_runner.run("cat", ["/proc/uptime"], timeout=5)
    if result.returncode == 0:
        try:
            seconds = int(float(result.stdout.split()[0]))
            info["uptime_seconds"] = seconds
            days, remainder = divmod(seconds, 86400)
            hours, remainder = divmod(remainder, 3600)
            minutes, _ = divmod(remainder, 60)
            info["uptime"] = f"{days} days, {hours}:{minutes:02d}"
        except (ValueError, IndexError):
            info["uptime"] = "unknown"
            info["uptime_seconds"] = 0

    info["timestamp"] = datetime.now(timezone.utc).isoformat()
    return info


@router.post("/reboot", responses={400: {"model": ApiError}})
async def reboot_system(request: RebootRequest) -> dict:
    """Reboot the system. Requires confirm=true in the request body."""
    if not request.confirm:
        raise HTTPException(
            status_code=400,
            detail="Reboot requires confirm=true in the request body.",
        )

    if settings.dev_mode:
        logger.info("Dev mode: reboot requested but not executed")
        return {"status": "ok", "message": "Reboot simulated (dev mode)"}

    logger.warning("System reboot initiated via API")
    result = await script_runner.run("sudo", ["reboot"], timeout=10)

    if result.returncode != 0:
        raise HTTPException(
            status_code=500,
            detail=f"Reboot command failed: {result.stderr}",
        )

    return {"status": "ok", "message": "System is rebooting"}
