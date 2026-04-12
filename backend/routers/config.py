"""Configuration management endpoints."""

import logging
import re

from fastapi import APIRouter, HTTPException

from backend.config import settings
from backend.models.schemas import ConfigUpdate
from backend.services import config_manager

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/config")

# Keys whose values should be masked in non-raw responses
_SENSITIVE_KEYS = re.compile(
    r"(password|passwd|secret|token|key|credential)", re.IGNORECASE
)
_MASK = "********"


def _sanitize(config: dict[str, str]) -> dict[str, str]:
    """Mask sensitive values in config output."""
    sanitized = {}
    for key, value in config.items():
        if _SENSITIVE_KEYS.search(key) and value:
            sanitized[key] = _MASK
        else:
            sanitized[key] = value
    return sanitized


@router.get("")
async def get_config() -> dict:
    """Return current configuration with sensitive values masked."""
    try:
        raw = config_manager.read_config()
    except Exception as exc:
        logger.error("Failed to read config: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))

    return {"config": _sanitize(raw), "keys": len(raw)}


@router.put("")
async def update_config(body: ConfigUpdate) -> dict:
    """Update configuration values.

    Preserves file format, comments, and ordering. Creates a backup
    before writing.
    """
    if not body.updates:
        raise HTTPException(status_code=400, detail="No updates provided")

    try:
        config_manager.write_config(body.updates)
    except FileNotFoundError:
        raise HTTPException(
            status_code=404,
            detail="Configuration file not found",
        )
    except Exception as exc:
        logger.error("Failed to write config: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))

    # Return the updated config (sanitized)
    updated = config_manager.read_config()
    return {
        "config": _sanitize(updated),
        "keys": len(updated),
        "updated": list(body.updates.keys()),
    }


@router.get("/raw")
async def get_raw_config() -> dict:
    """Return raw unsanitized configuration. Dev mode only."""
    if not settings.dev_mode:
        raise HTTPException(
            status_code=403,
            detail="Raw config access is only available in dev mode",
        )

    try:
        raw = config_manager.read_config()
    except Exception as exc:
        logger.error("Failed to read config: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))

    return {"config": raw, "keys": len(raw)}
