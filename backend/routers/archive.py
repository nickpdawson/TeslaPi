"""Archive endpoints for dashcam clip archival to network share."""

import logging

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from backend.services import dashcam_archive

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/archive")


class ArchiveStartRequest(BaseModel):
    trigger: str = "manual"
    delete_after: bool = False


class ArchiveStartResponse(BaseModel):
    job_id: int


@router.post("/start", response_model=ArchiveStartResponse)
async def start_archive(req: ArchiveStartRequest) -> ArchiveStartResponse:
    """Start a new archive job."""
    try:
        job_id = await dashcam_archive.start_archive(
            trigger=req.trigger,
            delete_after=req.delete_after,
        )
        return ArchiveStartResponse(job_id=job_id)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@router.get("/status")
async def get_archive_status() -> dict:
    """Get latest archive job status and aggregate stats."""
    return await dashcam_archive.get_archive_status()


@router.delete("")
async def cancel_archive() -> dict:
    """Cancel the currently running archive."""
    cancelled = await dashcam_archive.cancel_archive()
    if not cancelled:
        raise HTTPException(status_code=404, detail="No archive in progress")
    return {"cancelled": True}


@router.get("/history")
async def get_archive_history(
    limit: int = Query(default=20, ge=1, le=100),
) -> list[dict]:
    """Get past archive jobs."""
    return await dashcam_archive.get_archive_history(limit=limit)


@router.get("/clips")
async def get_archived_clips(
    event_type: str | None = Query(default=None),
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=50, ge=1, le=200),
) -> dict:
    """Get archived clips with optional filtering and pagination."""
    return await dashcam_archive.get_archived_clips(
        event_type=event_type,
        offset=offset,
        limit=limit,
    )
