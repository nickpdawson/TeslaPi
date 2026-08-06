"""Auto-sync background service — archives dashcam clips when on home network."""

import asyncio
import logging
from datetime import datetime, timezone

from backend import database
from backend.config import settings
from backend.services import dashcam_archive, script_runner

logger = logging.getLogger(__name__)

# Keys in the app_settings persistence store.
_SETTING_ENABLED = "auto_sync_enabled"
_SETTING_INTERVAL = "auto_sync_check_interval"

# Runtime state. `enabled`/`check_interval` are the DEFAULTS until load_persisted()
# overlays any saved values — so a user's choice survives a reboot (SOL-021).
_state: dict = {
    "enabled": True,
    "check_interval": 300,  # seconds
    "running": False,
    "last_check_at": None,
    "last_action": None,
    "last_action_at": None,
    "task": None,
}


async def load_persisted() -> None:
    """Overlay saved enabled/interval from app_settings onto the in-memory state.
    Called at start() so the loop honors the user's persisted choice instead of
    resetting to the enabled-by-default state on every boot."""
    enabled = await database.get_setting(_SETTING_ENABLED)
    if enabled is not None:
        _state["enabled"] = enabled == "true"
    interval = await database.get_setting(_SETTING_INTERVAL)
    if interval is not None:
        try:
            _state["check_interval"] = max(60, int(interval))
        except ValueError:
            logger.warning("Ignoring invalid persisted auto-sync interval: %r", interval)


def get_status() -> dict:
    """Return the current auto-sync status."""
    return {
        "enabled": _state["enabled"],
        "check_interval": _state["check_interval"],
        "running": _state["running"],
        "last_check_at": _state["last_check_at"],
        "last_action": _state["last_action"],
        "last_action_at": _state["last_action_at"],
    }


async def configure(enabled: bool | None = None, check_interval: int | None = None) -> dict:
    """Update auto-sync configuration and persist it so it survives a reboot.

    Args:
        enabled: Enable or disable auto-sync.
        check_interval: Seconds between checks (minimum 60).

    Returns:
        Updated status dict.
    """
    if enabled is not None:
        _state["enabled"] = enabled
        await database.set_setting(_SETTING_ENABLED, "true" if enabled else "false")
        logger.info("Auto-sync %s", "enabled" if enabled else "disabled")

    if check_interval is not None:
        _state["check_interval"] = max(60, check_interval)
        await database.set_setting(_SETTING_INTERVAL, str(_state["check_interval"]))
        logger.info("Auto-sync interval set to %ds", _state["check_interval"])

    return get_status()


async def start() -> None:
    """Start the auto-sync background loop.

    This should be called once from the application lifespan.  The loop
    runs indefinitely, checking every ``check_interval`` seconds whether
    conditions are right to trigger an automatic dashcam archive.
    """
    if _state["running"]:
        logger.warning("Auto-sync loop already running")
        return

    # Honor the persisted enabled/interval choice rather than the enabled-by-default.
    await load_persisted()

    _state["running"] = True
    logger.info(
        "Auto-sync loop started (enabled=%s, interval=%ds)",
        _state["enabled"],
        _state["check_interval"],
    )

    try:
        while True:
            await asyncio.sleep(_state["check_interval"])
            if _state["enabled"]:
                try:
                    await _check_and_sync()
                except Exception as exc:
                    logger.error("Auto-sync check failed: %s", exc, exc_info=True)
                    _state["last_action"] = f"error: {exc}"
                    _state["last_action_at"] = datetime.now(timezone.utc).isoformat()
    except asyncio.CancelledError:
        logger.info("Auto-sync loop cancelled")
    finally:
        _state["running"] = False


async def stop() -> None:
    """Cancel the auto-sync background task."""
    task = _state.get("task")
    if task and not task.done():
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
    _state["task"] = None
    _state["running"] = False
    logger.info("Auto-sync loop stopped")


async def _check_and_sync() -> None:
    """Evaluate conditions and trigger archive if appropriate.

    Decision tree:
    1. Is auto-sync enabled?  (already checked by caller)
    2. Is the archive server reachable?
    3. Is an archive already running?
    4. Are there unarchived clips?  (determined by archive service)

    If all conditions pass, start an automatic archive job.
    """
    now = datetime.now(timezone.utc).isoformat()
    _state["last_check_at"] = now

    # Check if archive server is reachable
    reachable = await _is_server_reachable()
    if not reachable:
        _state["last_action"] = "skipped: server unreachable"
        _state["last_action_at"] = now
        logger.debug("Auto-sync: archive server unreachable, skipping")
        return

    # Check if an archive is already running
    if dashcam_archive._active_archive["job_id"] is not None:
        _state["last_action"] = "skipped: archive already running"
        _state["last_action_at"] = now
        logger.debug("Auto-sync: archive already in progress, skipping")
        return

    # Trigger an auto-archive.  The archive service itself will mount the
    # cam image, discover unarchived clips, and handle the full lifecycle.
    # If there are no new clips it completes immediately.
    try:
        logger.info("Auto-sync: triggering automatic dashcam archive")
        job_id = await dashcam_archive.start_archive(trigger="auto")
        _state["last_action"] = f"started archive job {job_id}"
        _state["last_action_at"] = now
    except RuntimeError as exc:
        # e.g. "An archive is already in progress" — race condition guard
        _state["last_action"] = f"skipped: {exc}"
        _state["last_action_at"] = now
        logger.debug("Auto-sync: could not start archive: %s", exc)
    except Exception as exc:
        _state["last_action"] = f"error: {exc}"
        _state["last_action_at"] = now
        logger.error("Auto-sync: unexpected error starting archive: %s", exc)


async def _is_server_reachable() -> bool:
    """Quick ping test to the archive server."""
    if settings.dev_mode:
        return True

    share_cfg = dashcam_archive._get_archive_share_config()
    if not share_cfg or not share_cfg.get("server"):
        return False

    result = await script_runner.run(
        "ping", ["-c", "1", "-W", "2", share_cfg["server"]], timeout=5,
    )
    return result.returncode == 0
