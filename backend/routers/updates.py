"""OTA update management endpoints."""

import logging

from fastapi import APIRouter, HTTPException, UploadFile, File

from backend.config import settings
from backend.services.updater import updater

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/updates")


@router.get("/current-version")
async def get_current_version() -> dict:
    """Return the currently installed TeslaPi version."""
    version = await updater.get_current_version()
    return {"version": version}


@router.get("/check")
async def check_for_updates() -> dict:
    """Check GitHub releases for a newer version."""
    return await updater.check_for_updates()


@router.post("/download-and-apply")
async def download_and_apply() -> dict:
    """Download the latest release from GitHub and apply it."""
    status = updater.get_status()
    if status["in_progress"]:
        raise HTTPException(status_code=409, detail="An update is already in progress")
    return await updater.download_and_apply()


@router.post("/upload")
async def upload_and_apply(file: UploadFile = File(...)) -> dict:
    """Upload a tarball manually and apply it as an update."""
    status = updater.get_status()
    if status["in_progress"]:
        raise HTTPException(status_code=409, detail="An update is already in progress")

    if not file.filename or not (file.filename.endswith(".tar.gz") or file.filename.endswith(".tgz")):
        raise HTTPException(status_code=400, detail="File must be a .tar.gz or .tgz archive")

    content = await file.read()
    if len(content) == 0:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")

    return await updater.apply_uploaded_update(content, file.filename)


@router.post("/rollback")
async def rollback() -> dict:
    """Roll back to the previously backed-up version."""
    status = updater.get_status()
    if status["in_progress"]:
        raise HTTPException(status_code=409, detail="An update is already in progress")

    success = await updater.rollback()
    if success:
        return {"success": True, "message": "Rolled back to previous version"}
    raise HTTPException(status_code=500, detail="Rollback failed — no backup available or restore error")


@router.get("/history")
async def get_update_history() -> list[dict]:
    """Return the history of past updates."""
    return await updater.get_update_history()


@router.get("/status")
async def get_update_status() -> dict:
    """Return the status of an in-progress update."""
    return updater.get_status()


@router.put("/auto-check")
async def set_auto_check(body: dict) -> dict:
    """Configure automatic update checking.

    Body: {"enabled": bool, "interval_hours": int}
    """
    enabled = body.get("enabled", False)
    interval = body.get("interval_hours", 24)
    if not isinstance(interval, int) or interval < 1:
        raise HTTPException(status_code=400, detail="interval_hours must be a positive integer")
    return await updater.set_auto_update_config(enabled, interval)
