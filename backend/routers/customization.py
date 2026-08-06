"""Tesla customization endpoints -- lock chime, custom horn, etc."""

import logging
import os
import shutil
import tempfile

from fastapi import APIRouter, HTTPException, UploadFile

from backend.config import settings
from backend.services import script_runner

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/customization")

# Paths
BOOMBOX_IMAGE = "/backingfiles/boombox_disk.bin"
BOOMBOX_MOUNT = "/mnt/boombox"
LOCK_CHIME_FILENAME = "LockChime.wav"
GADGET_ENABLE = "/opt/teslapi/deploy/teslapi-gadget-enable.sh"
GADGET_DISABLE = "/opt/teslapi/deploy/teslapi-gadget-disable.sh"

MAX_FILE_SIZE = 10 * 1024 * 1024  # 10 MB


def _validate_wav_header(data: bytes) -> bool:
    """Check that data starts with a valid WAV header (RIFF....WAVE)."""
    if len(data) < 12:
        return False
    return data[:4] == b"RIFF" and data[8:12] == b"WAVE"


async def _is_mounted(path: str) -> bool:
    """Check if a path is an active mountpoint."""
    result = await script_runner.run("mountpoint", ["-q", path], timeout=5)
    return result.returncode == 0


async def _mount_boombox(read_only: bool = False) -> None:
    """Mount the boombox disk image."""
    if await _is_mounted(BOOMBOX_MOUNT):
        return
    opts = "loop,ro" if read_only else "loop"
    result = await script_runner.run(
        "mount", ["-o", opts, BOOMBOX_IMAGE, BOOMBOX_MOUNT], timeout=15,
    )
    if result.returncode != 0:
        raise HTTPException(
            status_code=503,
            detail=f"Failed to mount boombox image: {result.stderr}",
        )


async def _unmount_boombox() -> None:
    """Unmount the boombox disk image if mounted."""
    if await _is_mounted(BOOMBOX_MOUNT):
        await script_runner.run("umount", [BOOMBOX_MOUNT], timeout=15)


async def _disable_gadget() -> None:
    """Disable the USB gadget."""
    result = await script_runner.run("bash", [GADGET_DISABLE], timeout=15)
    if result.returncode != 0:
        logger.warning(
            "Gadget disable returned %d (may already be disabled)", result.returncode
        )


async def _enable_gadget() -> None:
    """Re-enable the USB gadget."""
    await script_runner.run("bash", [GADGET_ENABLE], timeout=15)


@router.post("/lock-chime")
async def upload_lock_chime(file: UploadFile) -> dict:
    """Upload a custom lock chime sound.

    Accepts any WAV file (max 10 MB), renames to LockChime.wav,
    and places it at the root of the boombox USB drive.

    Requires temporarily disabling the USB gadget.
    """
    # 1. Read file into memory in chunks, rejecting oversize BEFORE buffering the
    #    whole thing (a plain await file.read() buffers any size — OOM on a 2 GB post).
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_FILE_SIZE:
            raise HTTPException(
                status_code=400,
                detail=f"File too large. Maximum is {MAX_FILE_SIZE} bytes (10 MB).",
            )
        chunks.append(chunk)
    contents = b"".join(chunks)
    if total == 0:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")

    # 2. Validate WAV header
    if not _validate_wav_header(contents):
        raise HTTPException(
            status_code=400,
            detail="Invalid WAV file. The file must be a valid WAV audio file (RIFF/WAVE header).",
        )

    # 3. Dev mode -- skip gadget/mount, just log
    if settings.dev_mode:
        logger.info(
            "Dev mode: would write LockChime.wav (%d bytes) to boombox image",
            len(contents),
        )
        return {
            "message": "Lock chime uploaded successfully (dev mode)",
            "filename": LOCK_CHIME_FILENAME,
            "size": len(contents),
        }

    # 4. Write to boombox image via gadget lifecycle
    tmp_path = None
    try:
        # Save to temp file first
        fd, tmp_path = tempfile.mkstemp(suffix=".wav")
        os.write(fd, contents)
        os.close(fd)

        # Disable gadget
        await _disable_gadget()

        try:
            # Mount boombox rw
            await _mount_boombox(read_only=False)

            try:
                # Copy file as LockChime.wav
                dest = os.path.join(BOOMBOX_MOUNT, LOCK_CHIME_FILENAME)
                shutil.copy2(tmp_path, dest)
                logger.info("Installed LockChime.wav (%d bytes)", len(contents))
            finally:
                await _unmount_boombox()
        finally:
            await _enable_gadget()
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)

    return {
        "message": "Lock chime uploaded successfully",
        "filename": LOCK_CHIME_FILENAME,
        "size": len(contents),
    }


@router.get("/lock-chime")
async def get_lock_chime_status() -> dict:
    """Check if a custom lock chime is installed on the boombox drive."""
    if settings.dev_mode:
        # Return mock status in dev mode
        return {
            "installed": True,
            "filename": LOCK_CHIME_FILENAME,
            "size": 42_000,
        }

    already_mounted = await _is_mounted(BOOMBOX_MOUNT)

    try:
        if not already_mounted:
            await _mount_boombox(read_only=True)

        chime_path = os.path.join(BOOMBOX_MOUNT, LOCK_CHIME_FILENAME)
        if os.path.isfile(chime_path):
            size = os.path.getsize(chime_path)
            return {
                "installed": True,
                "filename": LOCK_CHIME_FILENAME,
                "size": size,
            }
        return {
            "installed": False,
            "filename": None,
            "size": 0,
        }
    finally:
        if not already_mounted:
            await _unmount_boombox()


@router.delete("/lock-chime")
async def remove_lock_chime() -> dict:
    """Remove the custom lock chime from the boombox drive."""
    if settings.dev_mode:
        logger.info("Dev mode: would remove LockChime.wav from boombox image")
        return {"message": "Lock chime removed (dev mode)", "removed": True}

    await _disable_gadget()

    try:
        await _mount_boombox(read_only=False)

        try:
            chime_path = os.path.join(BOOMBOX_MOUNT, LOCK_CHIME_FILENAME)
            if os.path.isfile(chime_path):
                os.unlink(chime_path)
                logger.info("Removed LockChime.wav from boombox image")
                return {"message": "Lock chime removed", "removed": True}
            return {"message": "No lock chime was installed", "removed": False}
        finally:
            await _unmount_boombox()
    finally:
        await _enable_gadget()
