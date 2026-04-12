"""Auto-sync API endpoints for configuring automatic dashcam archival."""

import logging

from fastapi import APIRouter
from pydantic import BaseModel, Field

from backend.services import auto_sync

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/auto-sync")


class AutoSyncConfig(BaseModel):
    enabled: bool | None = None
    check_interval: int | None = Field(default=None, ge=60, le=86400)


@router.get("/status")
async def get_auto_sync_status() -> dict:
    """Get current auto-sync status and last activity."""
    return auto_sync.get_status()


@router.put("/config")
async def update_auto_sync_config(body: AutoSyncConfig) -> dict:
    """Enable/disable auto-sync or change the check interval."""
    return auto_sync.configure(
        enabled=body.enabled,
        check_interval=body.check_interval,
    )
