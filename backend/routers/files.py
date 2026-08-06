"""File management endpoints for TeslaPi USB drives."""

import logging
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

from fastapi import APIRouter, HTTPException, UploadFile, File, Form
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field

from backend.config import settings

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/files")

# Allowed drive names and their mount points
_DRIVE_MOUNTS: dict[str, str] = {
    "cam": "/mnt/cam",
    "music": "/mnt/music",
    "lightshow": "/mnt/lightshow",
    "boombox": "/mnt/boombox",
}


class MoveRequest(BaseModel):
    src: str
    dst: str


class CopyRequest(BaseModel):
    src: str
    dst: str


class DeleteRequest(BaseModel):
    # The Files page multi-selects, so delete takes a list. confirm gates it.
    paths: list[str]
    confirm: bool = False


class MkdirRequest(BaseModel):
    # `path` is the parent directory; `name` is the new folder created inside it.
    # `name` is optional so a full path in `path` alone still works.
    path: str
    name: str | None = None


class FileEntry(BaseModel):
    # Serialized to the frontend contract (camelCase isDirectory, ISO modified).
    model_config = ConfigDict(populate_by_name=True)
    name: str
    path: str
    is_directory: bool = Field(serialization_alias="isDirectory")
    size: int = 0
    modified: str = ""


class FileListResponse(BaseModel):
    drive: str
    path: str
    parent: str | None = None
    entries: list[FileEntry] = Field(default_factory=list)


def _validate_drive(drive: str) -> Path:
    """Validate drive name and return the mount point Path.

    Raises HTTPException if the drive name is not allowed.
    """
    if drive not in _DRIVE_MOUNTS:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid drive '{drive}'. Must be one of: {', '.join(_DRIVE_MOUNTS.keys())}",
        )
    return Path(_DRIVE_MOUNTS[drive])


def _resolve_safe_path(mount: Path, relative_path: str) -> Path:
    """Resolve a path safely within the mount point.

    Prevents path traversal attacks by ensuring the resolved path
    is a child of the mount point.
    """
    # Normalize and strip leading slashes
    clean = PurePosixPath(relative_path).as_posix().lstrip("/")
    if clean == ".":
        clean = ""

    target = (mount / clean).resolve()
    mount_resolved = mount.resolve()

    # Ensure the resolved path starts with the mount point
    try:
        target.relative_to(mount_resolved)
    except ValueError:
        raise HTTPException(
            status_code=403,
            detail="Access denied: path escapes drive mount point",
        )

    return target


def _normalize_path(path: str) -> str:
    """Normalize a drive-relative path to a leading-slash canonical form."""
    clean = PurePosixPath(path or "/").as_posix().strip("/")
    return "/" + clean if clean else "/"


def _parent_of(path: str) -> str | None:
    """Return the parent path of a normalized path, or None at the drive root."""
    norm = _normalize_path(path)
    if norm == "/":
        return None
    return str(PurePosixPath(norm).parent)


def _iso(mtime: float) -> str:
    """Format an epoch mtime as an ISO 8601 UTC string for the frontend."""
    return datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat()


def _mock_ls(drive: str, subpath: str) -> list[FileEntry]:
    """Return mock directory listing for dev mode."""
    if drive == "cam":
        if not subpath or subpath == "/":
            return [
                FileEntry(name="TeslaCam", path="/TeslaCam", is_directory=True),
            ]
        if subpath.rstrip("/") == "/TeslaCam":
            return [
                FileEntry(name="SentryClips", path="/TeslaCam/SentryClips", is_directory=True),
                FileEntry(name="SavedClips", path="/TeslaCam/SavedClips", is_directory=True),
                FileEntry(name="RecentClips", path="/TeslaCam/RecentClips", is_directory=True),
            ]
        return [
            FileEntry(
                name="2026-04-09_14-34-00-front.mp4",
                path=f"{subpath}/2026-04-09_14-34-00-front.mp4",
                is_directory=False,
                size=52_428_800,
                modified=_iso(1744205640.0),
            ),
            FileEntry(
                name="2026-04-09_14-34-00-back.mp4",
                path=f"{subpath}/2026-04-09_14-34-00-back.mp4",
                is_directory=False,
                size=39_321_600,
                modified=_iso(1744205640.0),
            ),
        ]
    elif drive == "music":
        return [
            FileEntry(name="Radiohead", path="/Radiohead", is_directory=True),
            FileEntry(name="Led Zeppelin", path="/Led Zeppelin", is_directory=True),
            FileEntry(name="playlist.m3u", path="/playlist.m3u", is_directory=False, size=1024, modified=_iso(1744119240.0)),
        ]
    elif drive == "lightshow":
        return [
            FileEntry(name="xmas_lights.fseq", path="/xmas_lights.fseq", is_directory=False, size=2_097_152, modified=_iso(1702425600.0)),
            FileEntry(name="lightshow.fseq", path="/lightshow.fseq", is_directory=False, size=1_048_576, modified=_iso(1702339200.0)),
        ]
    elif drive == "boombox":
        return [
            FileEntry(name="horn.wav", path="/horn.wav", is_directory=False, size=524_288, modified=_iso(1744032840.0)),
            FileEntry(name="ice_cream.wav", path="/ice_cream.wav", is_directory=False, size=1_048_576, modified=_iso(1744032840.0)),
        ]
    return []


@router.get("/{drive}/ls", response_model=FileListResponse)
async def list_directory(drive: str, path: str = "/") -> FileListResponse:
    """List directory contents for a drive.

    Returns the drive, the normalized path, its parent (null at the root), and the
    files/directories at that path. Validates the drive name and prevents path
    traversal.
    """
    mount = _validate_drive(drive)
    norm = _normalize_path(path)

    if settings.dev_mode:
        return FileListResponse(
            drive=drive, path=norm, parent=_parent_of(norm), entries=_mock_ls(drive, norm),
        )

    target = _resolve_safe_path(mount, path)

    if not target.exists():
        raise HTTPException(status_code=404, detail=f"Path not found: {path}")
    if not target.is_dir():
        raise HTTPException(status_code=400, detail=f"Path is not a directory: {path}")

    entries: list[FileEntry] = []
    try:
        for item in sorted(target.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())):
            stat = item.stat()
            rel_path = "/" + str(item.relative_to(mount))
            entries.append(FileEntry(
                name=item.name,
                path=rel_path,
                is_directory=item.is_dir(),
                size=stat.st_size if not item.is_dir() else 0,
                modified=_iso(stat.st_mtime),
            ))
    except PermissionError:
        raise HTTPException(status_code=403, detail="Permission denied reading directory")
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Error reading directory: {exc}")

    return FileListResponse(drive=drive, path=norm, parent=_parent_of(norm), entries=entries)


@router.post("/{drive}/upload")
async def upload_file(drive: str, file: UploadFile = File(...), path: str = Form("/")) -> dict:
    """Upload a file to the specified drive and path.

    Accepts multipart file upload and writes it to the drive mount
    point at the specified path. Creates parent directories if needed.
    """
    mount = _validate_drive(drive)

    if settings.dev_mode:
        return {"status": "ok", "message": f"File '{file.filename}' uploaded (dev mode)", "size": 0}

    target_dir = _resolve_safe_path(mount, path)
    if not target_dir.exists():
        target_dir.mkdir(parents=True, exist_ok=True)

    if not file.filename:
        raise HTTPException(status_code=400, detail="No filename provided")

    target_file = _resolve_safe_path(mount, f"{path}/{file.filename}")

    try:
        with open(target_file, "wb") as f:
            while chunk := await file.read(1024 * 1024):  # 1MB chunks
                f.write(chunk)
        size = target_file.stat().st_size
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Error writing file: {exc}")

    logger.info("Uploaded %s to %s/%s (%d bytes)", file.filename, drive, path, size)
    return {"status": "ok", "message": f"File '{file.filename}' uploaded", "size": size}


@router.get("/{drive}/download")
async def download_file(drive: str, path: str) -> FileResponse:
    """Download a file from the specified drive.

    Serves the file with Content-Disposition header for browser download.
    Only allows file downloads (not directories).
    """
    mount = _validate_drive(drive)

    if settings.dev_mode:
        raise HTTPException(status_code=501, detail="File download not available in dev mode")

    target = _resolve_safe_path(mount, path)

    if not target.exists():
        raise HTTPException(status_code=404, detail=f"File not found: {path}")
    if target.is_dir():
        raise HTTPException(status_code=400, detail="Cannot download a directory")

    return FileResponse(
        str(target),
        filename=target.name,
        media_type="application/octet-stream",
    )


@router.post("/{drive}/mkdir")
async def make_directory(drive: str, body: MkdirRequest) -> dict:
    """Create a new directory at the specified path.

    Creates parent directories as needed. Returns an error if the
    path already exists.
    """
    mount = _validate_drive(drive)

    # `name` (when sent) is a new folder created inside the parent `path`. A name
    # containing a path separator would let mkdir escape the parent, so reject it.
    if body.name is not None:
        if not body.name.strip() or "/" in body.name or body.name in (".", ".."):
            raise HTTPException(status_code=400, detail="Invalid folder name")
        new_path = f"{body.path.rstrip('/')}/{body.name}"
    else:
        new_path = body.path

    if settings.dev_mode:
        return {"status": "ok", "message": f"Directory created (dev mode): {new_path}"}

    target = _resolve_safe_path(mount, new_path)

    if target.exists():
        raise HTTPException(status_code=409, detail=f"Path already exists: {new_path}")

    try:
        target.mkdir(parents=True, exist_ok=False)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Error creating directory: {exc}")

    logger.info("Created directory %s/%s", drive, new_path)
    return {"status": "ok", "message": f"Directory created: {new_path}"}


@router.post("/{drive}/mv")
async def move_file(drive: str, body: MoveRequest) -> dict:
    """Move or rename a file or directory within a drive.

    Both source and destination must be within the same drive
    mount point. Cannot overwrite existing files.
    """
    mount = _validate_drive(drive)

    if settings.dev_mode:
        return {"status": "ok", "message": f"Moved (dev mode): {body.src} -> {body.dst}"}

    src = _resolve_safe_path(mount, body.src)
    dst = _resolve_safe_path(mount, body.dst)

    if not src.exists():
        raise HTTPException(status_code=404, detail=f"Source not found: {body.src}")
    if dst.exists():
        raise HTTPException(status_code=409, detail=f"Destination already exists: {body.dst}")

    try:
        # Ensure parent directory exists
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(src), str(dst))
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Error moving file: {exc}")

    logger.info("Moved %s/%s -> %s", drive, body.src, body.dst)
    return {"status": "ok", "message": f"Moved: {body.src} -> {body.dst}"}


@router.post("/{drive}/rm")
async def remove_file(drive: str, body: DeleteRequest) -> dict:
    """Delete one or more files/directories from a drive.

    Requires confirm=true in the request body. Directories are removed recursively.
    Every path is containment-checked before anything is deleted.
    """
    mount = _validate_drive(drive)

    if not body.confirm:
        raise HTTPException(
            status_code=400,
            detail="Delete requires confirm=true in the request body",
        )
    if not body.paths:
        raise HTTPException(status_code=400, detail="No paths provided")

    # Containment-check ALL paths first (no filesystem access — this only resolves
    # and range-checks), so an escaping path in the batch aborts the whole request.
    targets: list[tuple[str, Path]] = [
        (rel, _resolve_safe_path(mount, rel)) for rel in body.paths
    ]

    if settings.dev_mode:
        return {"status": "ok", "message": f"Deleted (dev mode): {', '.join(body.paths)}"}

    # Verify every target exists before deleting any, so a missing path doesn't leave
    # a half-completed batch.
    for rel, target in targets:
        if not target.exists():
            raise HTTPException(status_code=404, detail=f"Path not found: {rel}")

    deleted: list[str] = []
    try:
        for rel, target in targets:
            if target.is_dir():
                shutil.rmtree(str(target))
            else:
                target.unlink()
            deleted.append(rel)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Error deleting: {exc}")

    logger.info("Deleted %s: %s", drive, ", ".join(deleted))
    return {"status": "ok", "message": f"Deleted: {', '.join(deleted)}"}


@router.post("/{drive}/cp")
async def copy_file(drive: str, body: CopyRequest) -> dict:
    """Copy a file or directory within a drive.

    Both source and destination must be within the same drive
    mount point. Directories are copied recursively.
    """
    mount = _validate_drive(drive)

    if settings.dev_mode:
        return {"status": "ok", "message": f"Copied (dev mode): {body.src} -> {body.dst}"}

    src = _resolve_safe_path(mount, body.src)
    dst = _resolve_safe_path(mount, body.dst)

    if not src.exists():
        raise HTTPException(status_code=404, detail=f"Source not found: {body.src}")
    if dst.exists():
        raise HTTPException(status_code=409, detail=f"Destination already exists: {body.dst}")

    try:
        dst.parent.mkdir(parents=True, exist_ok=True)
        if src.is_dir():
            shutil.copytree(str(src), str(dst))
        else:
            shutil.copy2(str(src), str(dst))
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Error copying: {exc}")

    logger.info("Copied %s/%s -> %s", drive, body.src, body.dst)
    return {"status": "ok", "message": f"Copied: {body.src} -> {body.dst}"}
