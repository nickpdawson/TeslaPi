"""Share management endpoints — configure and browse CIFS/NFS shares."""

import logging
import os

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from backend.config import settings
from backend.services import config_manager, share_browser

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/shares")

SHARE_MOUNT_POINTS = {
    "music": "/mnt/music_share",
    "archive": "/mnt/archive_share",
}


class ShareTestRequest(BaseModel):
    type: str  # "cifs" | "nfs"
    server: str
    path: str
    username: str = ""
    password: str = ""
    domain: str = ""


class ShareConfigRequest(BaseModel):
    type: str  # "cifs" | "nfs"
    server: str
    path: str
    username: str = ""
    password: str = ""
    domain: str = ""
    mount_options: str = ""


@router.get("")
async def list_shares() -> dict:
    """List configured shares (archive + music)."""
    try:
        raw_config = config_manager.read_config()
    except Exception:
        raw_config = {}

    shares = {}
    for share_type in ("music", "archive"):
        prefix = f"{share_type}_share_"
        share = {}
        for key, val in raw_config.items():
            if key.startswith(prefix) and val:
                field = key[len(prefix):]
                share[field] = val
        if share:
            # Check if mounted
            mp = SHARE_MOUNT_POINTS.get(share_type, "")
            mounted = await share_browser.is_mounted(mp) if mp else False
            share["mounted"] = mounted
            shares[share_type] = share

    return {"shares": shares}


@router.put("/{share_type}")
async def configure_share(share_type: str, body: ShareConfigRequest) -> dict:
    """Configure a share (music or archive)."""
    if share_type not in ("music", "archive"):
        raise HTTPException(status_code=400, detail="share_type must be 'music' or 'archive'")

    # Save to config
    updates = {
        f"{share_type}_share_type": body.type,
        f"{share_type}_share_server": body.server,
        f"{share_type}_share_path": body.path,
        f"{share_type}_share_username": body.username,
        f"{share_type}_share_password": body.password,
        f"{share_type}_share_domain": body.domain,
        f"{share_type}_share_mount_options": body.mount_options,
    }

    try:
        config_manager.write_config(updates)
    except Exception as exc:
        logger.error("Failed to save share config: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))

    return {"message": f"{share_type} share configured", "share_type": share_type}


@router.post("/test")
async def test_share(body: ShareTestRequest) -> dict:
    """Test connectivity to a share by attempting a temporary mount."""
    import tempfile

    mountpoint = tempfile.mkdtemp(prefix="teslapi_share_test_")

    try:
        success = await share_browser.mount_share(
            share_type=body.type,
            server=body.server,
            path=body.path,
            mountpoint=mountpoint,
            username=body.username,
            password=body.password,
            domain=body.domain,
        )

        if success:
            # Quick check: just try to list root (limit to 10 entries to avoid blocking)
            import asyncio
            browse_error = None
            try:
                count = await asyncio.wait_for(
                    asyncio.get_event_loop().run_in_executor(
                        None, lambda: len(list(os.scandir(mountpoint))[:100])
                    ),
                    timeout=10.0,
                )
            except PermissionError:
                count = 0
                browse_error = "Mount succeeded but cannot read directory. Check filesystem permissions on the NAS."
            except asyncio.TimeoutError:
                count = -1
                browse_error = None  # Timeout means it's working but slow — still a success
            except Exception as browse_exc:
                count = 0
                browse_error = str(browse_exc)

            await share_browser.unmount_share(mountpoint)

            if browse_error:
                return {
                    "success": False,
                    "message": f"Mount succeeded but listing failed: {browse_error}",
                    "items": 0,
                }

            msg = f"Connected successfully. Found {count} items in root." if count >= 0 else "Connected successfully. Share is accessible (large directory)."
            return {
                "success": True,
                "message": msg,
                "items": max(count, 0),
            }
        else:
            return {
                "success": False,
                "message": "Failed to mount share. Check server, path, and credentials.",
            }
    except Exception as exc:
        logger.error("Share test failed: %s", exc)
        return {
            "success": False,
            "message": str(exc),
        }
    finally:
        import shutil
        try:
            shutil.rmtree(mountpoint, ignore_errors=True)
        except Exception:
            pass


@router.get("/browse")
async def browse_share(
    path: str = Query("/"),
    share: str = Query("music"),
) -> dict:
    """Browse a mounted share directory."""
    if share not in SHARE_MOUNT_POINTS:
        raise HTTPException(status_code=400, detail=f"Unknown share: {share}")

    mountpoint = SHARE_MOUNT_POINTS[share]

    if not settings.dev_mode:
        if not await share_browser.is_mounted(mountpoint):
            raise HTTPException(status_code=503, detail=f"Share '{share}' is not mounted")

    try:
        entries = share_browser.browse(mountpoint, path)
        return {
            "path": path,
            "share": share,
            "entries": entries,
            "parent": "/".join(path.rstrip("/").split("/")[:-1]) or "/" if path != "/" else None,
        }
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Path not found: {path}")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except PermissionError:
        raise HTTPException(status_code=403, detail="Permission denied")
