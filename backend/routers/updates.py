"""OTA update management endpoints."""

import logging
import os

from fastapi import APIRouter, HTTPException, Request

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


_MAX_UPLOAD_BYTES = 300 * 1024 * 1024  # 300 MB hard cap (service is memory-limited)


@router.post("/upload")
async def upload_and_apply(request: Request) -> dict:
    """Upload a tarball manually and apply it as an update."""
    # Applying an uploaded tarball runs its install.sh as root. With no signature
    # verification or API auth yet, that is unauthenticated remote root execution —
    # refuse BEFORE parsing the request body (taking Request, not File(...), so the
    # multipart body isn't ingested just to reject it).
    if not settings.allow_unsigned_updates:
        raise HTTPException(
            status_code=403,
            detail=(
                "Manual (unsigned) update upload is disabled. It runs code as root "
                "and cannot be verified. Enable TESLAPI_ALLOW_UNSIGNED_UPDATES=true "
                "only if you understand the risk."
            ),
        )

    status = updater.get_status()
    if status["in_progress"]:
        raise HTTPException(status_code=409, detail="An update is already in progress")

    form = await request.form()
    file = form.get("file")
    if file is None or isinstance(file, str):
        raise HTTPException(status_code=400, detail="No file provided")

    # Sanitize the client filename to a basename so it can't escape UPDATE_DIR
    # (e.g. "../../mutable/teslapi/x.tar.gz"), then re-check the extension.
    safe_name = os.path.basename(file.filename or "")
    if not (safe_name.endswith(".tar.gz") or safe_name.endswith(".tgz")):
        raise HTTPException(status_code=400, detail="File must be a .tar.gz or .tgz archive")

    # Stream to disk with a hard size cap instead of buffering the whole upload in
    # memory (the service runs under a tight MemoryMax — an unbounded read OOMs it).
    os.makedirs(updater.UPDATE_DIR, exist_ok=True)
    dest = os.path.join(updater.UPDATE_DIR, safe_name)
    total = 0
    try:
        with open(dest, "wb") as fh:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > _MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail="Uploaded file is too large")
                fh.write(chunk)
    except HTTPException:
        if os.path.exists(dest):
            os.remove(dest)
        raise
    finally:
        await file.close()

    if total == 0:
        if os.path.exists(dest):
            os.remove(dest)
        raise HTTPException(status_code=400, detail="Uploaded file is empty")

    return await updater.apply_uploaded_update(dest)


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


@router.get("/auto-check")
async def get_auto_check() -> dict:
    """Return the persisted automatic-update-check configuration.

    The Settings UI GETs this on load to show the current toggle/interval; without
    it the endpoint only had a PUT, so the initial load 405'd and the control could
    never reflect its saved state.
    """
    return await updater.get_auto_update_config()


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
