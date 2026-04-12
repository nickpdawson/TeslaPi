"""Setup wizard endpoints for first-run configuration."""

import json
import logging
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.config import settings
from backend.services import config_manager
from backend.services.pi_setup import pi_setup

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/setup")

_SETUP_FILE = Path("/mutable/teslapi/setup.json")
_VERSION = "0.1.0"


# --- Models ---


class SetupStatus(BaseModel):
    setupComplete: bool
    hasExistingConfig: bool
    detectedConfig: dict | None = None


class SetupValidateRequest(BaseModel):
    step: str
    config: dict


class SetupValidateResponse(BaseModel):
    valid: bool
    errors: dict[str, str] = {}
    message: str = ""


class SetupCompleteRequest(BaseModel):
    wifi: dict | None = None
    storage: dict | None = None
    archive: dict | None = None


class DetectedHardware(BaseModel):
    drives: list[dict] = []
    wifiInterfaces: list[str] = []
    existingConfig: dict = {}
    hostname: str = ""


# --- Helpers ---


def _read_setup_state() -> dict:
    """Read the setup state file."""
    if _SETUP_FILE.exists():
        try:
            return json.loads(_SETUP_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as exc:
            logger.warning("Failed to read setup state: %s", exc)
    return {}


def _write_setup_state(state: dict) -> None:
    """Write the setup state file."""
    _SETUP_FILE.parent.mkdir(parents=True, exist_ok=True)
    _SETUP_FILE.write_text(json.dumps(state, indent=2), encoding="utf-8")


def _detect_existing_config() -> dict:
    """Try to read existing teslausb_setup_variables.conf."""
    try:
        raw = config_manager.read_config()
        if raw:
            return raw
    except Exception as exc:
        logger.debug("No existing config detected: %s", exc)
    return {}


def _detect_hardware() -> dict:
    """Detect available hardware (drives, WiFi, etc.)."""
    hardware: dict = {
        "drives": [],
        "wifiInterfaces": [],
        "hostname": "",
    }

    if settings.dev_mode:
        # Return mock data in dev mode
        hardware["drives"] = [
            {"device": "/dev/sda", "size": "500GB", "model": "Samsung EVO 500GB"},
        ]
        hardware["wifiInterfaces"] = ["wlan0"]
        hardware["hostname"] = "teslapi-dev"
        return hardware

    # Real hardware detection
    try:
        import subprocess

        # Detect block devices
        result = subprocess.run(
            ["lsblk", "-J", "-o", "NAME,SIZE,MODEL,TYPE"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0:
            import json as _json

            data = _json.loads(result.stdout)
            for dev in data.get("blockdevices", []):
                if dev.get("type") == "disk":
                    hardware["drives"].append(
                        {
                            "device": f"/dev/{dev['name']}",
                            "size": dev.get("size", ""),
                            "model": (dev.get("model") or "").strip(),
                        }
                    )
    except Exception as exc:
        logger.debug("Drive detection failed: %s", exc)

    try:
        import subprocess

        result = subprocess.run(
            ["iw", "dev"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0:
            for line in result.stdout.splitlines():
                line = line.strip()
                if line.startswith("Interface "):
                    hardware["wifiInterfaces"].append(line.split()[1])
    except Exception as exc:
        logger.debug("WiFi detection failed: %s", exc)

    try:
        import socket

        hardware["hostname"] = socket.gethostname()
    except Exception:
        pass

    return hardware


def _mock_detected_config() -> dict:
    """Return mock detected config for dev mode."""
    return {
        "ARCHIVE_SYSTEM": "cifs",
        "ARCHIVE_SERVER": "192.168.1.100",
        "SHARE_NAME": "teslacam",
        "SHARE_USER": "tesla",
        "SHARE_PASSWORD": "",
        "WIFI_SSID": "MyHomeWiFi",
        "WIFI_PASS": "",
        "DATA_DRIVE": "/dev/sda1",
        "CAM_SIZE": "40G",
        "MUSIC_SIZE": "20G",
        "LIGHTSHOW_SIZE": "1G",
        "BOOMBOX_SIZE": "1G",
        "FILESYSTEMS": "exfat",
        "HOSTNAME": "teslapi",
    }


# --- Endpoints ---


@router.get("/status")
async def get_setup_status() -> SetupStatus:
    """Check if first-run setup has been completed."""
    state = _read_setup_state()
    is_complete = state.get("complete", False)

    existing = _detect_existing_config()
    has_existing = len(existing) > 0

    detected = None
    if not is_complete:
        if settings.dev_mode and not has_existing:
            detected = _mock_detected_config()
            has_existing = True
        elif has_existing:
            detected = existing

    return SetupStatus(
        setupComplete=is_complete,
        hasExistingConfig=has_existing,
        detectedConfig=detected,
    )


@router.get("/detect")
async def detect_environment() -> dict:
    """Detect existing teslausb config and available hardware."""
    existing = _detect_existing_config()
    hardware = _detect_hardware()

    if settings.dev_mode and not existing:
        existing = _mock_detected_config()

    return {
        "existingConfig": existing,
        "hardware": hardware,
    }


@router.post("/validate")
async def validate_step(body: SetupValidateRequest) -> SetupValidateResponse:
    """Validate a single setup step's configuration."""
    errors: dict[str, str] = {}

    if body.step == "wifi":
        ssid = body.config.get("ssid", "").strip()
        if not ssid:
            errors["ssid"] = "WiFi network name is required"

    elif body.step == "storage":
        cam_size = body.config.get("camSize", "").strip()
        if cam_size:
            # Validate it looks like a size (number with optional G/M suffix)
            import re

            if not re.match(r"^\d+[GM]?$", cam_size, re.IGNORECASE):
                errors["camSize"] = "Invalid size format. Use a number like 40G or 40"

    elif body.step == "archive":
        archive_type = body.config.get("type", "none")
        if archive_type in ("cifs", "nfs"):
            server = body.config.get("server", "").strip()
            if not server:
                errors["server"] = "Server address is required"
            share_path = body.config.get("path", "").strip()
            if not share_path:
                errors["path"] = "Share path is required"
            if archive_type == "cifs":
                username = body.config.get("username", "").strip()
                if not username:
                    errors["username"] = "Username is required for CIFS shares"

        # In dev mode, simulate a connection test
        if settings.dev_mode and not errors and body.config.get("testConnection"):
            return SetupValidateResponse(
                valid=True,
                message="Connection test successful (dev mode)",
            )

    else:
        # Unknown step, just pass through
        pass

    if errors:
        return SetupValidateResponse(valid=False, errors=errors)

    return SetupValidateResponse(valid=True, message="Configuration is valid")


@router.post("/complete")
async def complete_setup(body: SetupCompleteRequest) -> dict:
    """Write all configuration and mark setup as complete."""
    config_updates: dict[str, str] = {}

    # WiFi config
    if body.wifi:
        ssid = body.wifi.get("ssid", "")
        password = body.wifi.get("password", "")
        if ssid:
            config_updates["WIFI_SSID"] = ssid
        if password:
            config_updates["WIFI_PASS"] = password

    # Storage config
    if body.storage:
        cam_size = body.storage.get("camSize", "")
        music_size = body.storage.get("musicSize", "")
        lightshow_size = body.storage.get("lightshowSize", "")
        boombox_size = body.storage.get("boomboxSize", "")
        filesystem = body.storage.get("filesystem", "exfat")
        data_drive = body.storage.get("dataDrive", "")

        if cam_size:
            config_updates["CAM_SIZE"] = cam_size
        if music_size:
            config_updates["MUSIC_SIZE"] = music_size
        if lightshow_size:
            config_updates["LIGHTSHOW_SIZE"] = lightshow_size
        if boombox_size:
            config_updates["BOOMBOX_SIZE"] = boombox_size
        if filesystem:
            config_updates["FILESYSTEMS"] = filesystem
        if data_drive:
            config_updates["DATA_DRIVE"] = data_drive

    # Archive config
    if body.archive:
        archive_type = body.archive.get("type", "none")
        config_updates["ARCHIVE_SYSTEM"] = archive_type

        if archive_type in ("cifs", "nfs"):
            server = body.archive.get("server", "")
            path = body.archive.get("path", "")
            if server:
                config_updates["ARCHIVE_SERVER"] = server
            if path:
                config_updates["SHARE_NAME"] = path
            if archive_type == "cifs":
                username = body.archive.get("username", "")
                password = body.archive.get("password", "")
                if username:
                    config_updates["SHARE_USER"] = username
                if password:
                    config_updates["SHARE_PASSWORD"] = password

    # Write config file (only if we have updates and file exists, or dev mode)
    if config_updates:
        try:
            config_manager.write_config(config_updates)
            logger.info("Setup wizard wrote %d config values", len(config_updates))
        except FileNotFoundError:
            if not settings.dev_mode:
                raise HTTPException(
                    status_code=500,
                    detail="Configuration file not found. Is teslausb installed?",
                )
            logger.info("Dev mode: skipping config write (file not found)")
        except Exception as exc:
            logger.error("Failed to write config: %s", exc)
            raise HTTPException(status_code=500, detail=str(exc))

    # Mark setup as complete
    setup_state = {
        "complete": True,
        "completed_at": datetime.now(timezone.utc).isoformat(),
        "version": _VERSION,
    }

    try:
        _write_setup_state(setup_state)
    except Exception as exc:
        if not settings.dev_mode:
            logger.error("Failed to write setup state: %s", exc)
            raise HTTPException(status_code=500, detail="Failed to save setup state")
        logger.info("Dev mode: setup state write failed (expected): %s", exc)

    # Start hardware provisioning if not already done
    hardware_complete = await pi_setup.is_complete()
    if not hardware_complete:
        logger.info("Hardware not provisioned yet, starting provisioning...")
        started = await pi_setup.start_setup(config_updates)
        if started:
            return {
                "success": True,
                "message": "Configuration saved. Hardware provisioning started.",
                "configKeysWritten": len(config_updates),
                "provisioningStarted": True,
            }

    return {
        "success": True,
        "message": "Setup complete! TeslaPi is ready to use.",
        "configKeysWritten": len(config_updates),
        "provisioningStarted": False,
    }


# --- Provisioning endpoints ---


class ProvisionRequest(BaseModel):
    config: dict = {}


@router.post("/provision")
async def start_provisioning(body: ProvisionRequest) -> dict:
    """Start hardware provisioning (partition drive, create images, configure gadget)."""
    is_running = await pi_setup.is_running()
    if is_running:
        raise HTTPException(status_code=409, detail="Provisioning is already running")

    started = await pi_setup.start_setup(body.config)
    if not started:
        raise HTTPException(status_code=500, detail="Failed to start provisioning")

    return {
        "success": True,
        "message": "Provisioning started",
    }


@router.get("/provision/progress")
async def get_provision_progress() -> dict:
    """Get current provisioning progress (polled by frontend)."""
    return await pi_setup.get_progress()


@router.get("/provision/log")
async def get_provision_log(lines: int = 100) -> dict:
    """Get the last N lines of the provisioning log."""
    log_text = await pi_setup.get_log(lines=lines)
    return {
        "log": log_text,
        "lines": lines,
    }


@router.post("/provision/cancel")
async def cancel_provisioning() -> dict:
    """Cancel a running provisioning process."""
    cancelled = await pi_setup.cancel()
    return {
        "cancelled": cancelled,
        "message": "Provisioning cancelled" if cancelled else "No provisioning to cancel",
    }


@router.get("/hardware")
async def get_hardware_status() -> dict:
    """Check hardware configuration status."""
    return await pi_setup.get_hardware_status()
