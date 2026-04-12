"""Unified notification dispatcher for TeslaPi events."""

import json
import logging
import smtplib
from datetime import datetime, timezone
from email.mime.text import MIMEText
from typing import Any

import aiosqlite

from backend.config import settings
from backend.database import get_db
from backend.services import script_runner

logger = logging.getLogger(__name__)

# Supported event types
EVENT_TYPES = [
    "archive_complete",
    "archive_error",
    "sync_complete",
    "sync_error",
    "storage_warning",
    "gadget_toggle",
    "system_error",
    "test",
]


class NotificationService:
    """Routes notifications to configured channels based on event rules."""

    def __init__(self) -> None:
        self._channels: dict[str, dict[str, Any]] = {}
        self._rules: dict[str, list[str]] = {}

    async def load_channels(self) -> None:
        """Load notification channels and rules from the database."""
        async with get_db() as db:
            # Load channels
            cursor = await db.execute(
                "SELECT id, enabled, config_json FROM notification_channels"
            )
            rows = await cursor.fetchall()
            self._channels = {}
            for row in rows:
                self._channels[row["id"]] = {
                    "id": row["id"],
                    "enabled": bool(row["enabled"]),
                    "config": json.loads(row["config_json"]) if row["config_json"] else {},
                }

            # Load rules
            cursor = await db.execute(
                "SELECT event_type, channel_id, enabled FROM notification_rules"
            )
            rule_rows = await cursor.fetchall()
            self._rules = {}
            for row in rule_rows:
                if bool(row["enabled"]):
                    self._rules.setdefault(row["event_type"], []).append(
                        row["channel_id"]
                    )

        logger.info(
            "Loaded %d notification channels, %d event rules",
            len(self._channels),
            sum(len(v) for v in self._rules.values()),
        )

    async def send(self, event_type: str, title: str, message: str) -> list[dict[str, Any]]:
        """Send a notification to all channels configured for this event type.

        Returns a list of result dicts with channel_id and status.
        """
        results: list[dict[str, Any]] = []

        # Get channels for this event type
        channel_ids = self._rules.get(event_type, [])
        if not channel_ids:
            logger.debug("No channels configured for event type: %s", event_type)
            return results

        for channel_id in channel_ids:
            channel = self._channels.get(channel_id)
            if not channel or not channel["enabled"]:
                continue

            result = await self._dispatch(channel, event_type, title, message)
            results.append(result)

        return results

    async def send_to_channel(
        self, channel_id: str, title: str, message: str
    ) -> dict[str, Any]:
        """Send a notification directly to a specific channel (e.g. for testing)."""
        channel = self._channels.get(channel_id)
        if not channel:
            return {
                "channel_id": channel_id,
                "status": "error",
                "error": "Channel not found",
            }
        return await self._dispatch(channel, "test", title, message)

    async def _dispatch(
        self,
        channel: dict[str, Any],
        event_type: str,
        title: str,
        message: str,
    ) -> dict[str, Any]:
        """Route a notification to the correct handler and log the result."""
        channel_id = channel["id"]
        config = channel["config"]
        channel_type = config.get("type", "push")

        status = "sent"
        error_msg: str | None = None

        try:
            if settings.dev_mode:
                logger.info(
                    "Dev mode: would send %s notification via %s (%s): %s - %s",
                    event_type, channel_id, channel_type, title, message,
                )
            elif channel_type == "email":
                await self._send_email(config, title, message)
            elif channel_type == "ha":
                await self._send_ha(config, title, message)
            else:
                # Default: use the send-push-message bash script
                await self._send_push(config, title, message)
        except Exception as exc:
            status = "error"
            error_msg = str(exc)
            logger.warning(
                "Failed to send notification via %s: %s", channel_id, exc
            )

        # Log to history
        await self._log_history(channel_id, event_type, title, message, status, error_msg)

        return {
            "channel_id": channel_id,
            "status": status,
            "error": error_msg,
        }

    async def _send_push(
        self, config: dict[str, Any], title: str, message: str
    ) -> None:
        """Send notification via the send-push-message bash script.

        The script reads environment variables to determine which services
        (Telegram, Discord, Slack, Pushover, Gotify, etc.) are enabled.
        """
        # Build environment variables from channel config
        env_vars: list[str] = []
        for key, value in config.items():
            if key == "type":
                continue
            # Convert config keys to uppercase env vars
            env_key = key.upper()
            env_vars.append(f"{env_key}={value}")

        # The script expects: title message [type]
        env_prefix = " ".join(env_vars)
        if env_prefix:
            cmd = f"{env_prefix} run/send-push-message"
        else:
            cmd = "run/send-push-message"

        result = await script_runner.run(
            "bash",
            ["-c", f'{cmd} "{title}" "{message}"'],
            timeout=30,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"send-push-message failed (rc={result.returncode}): {result.stderr}"
            )

    async def _send_email(
        self, config: dict[str, Any], title: str, message: str
    ) -> None:
        """Send notification via SMTP email."""
        smtp_server = config.get("smtp_server", "localhost")
        smtp_port = int(config.get("smtp_port", 587))
        use_tls = config.get("smtp_tls", True)
        username = config.get("smtp_username", "")
        password = config.get("smtp_password", "")
        from_addr = config.get("from_address", "teslapi@localhost")
        to_addr = config.get("to_address", "")

        if not to_addr:
            raise ValueError("Email channel missing to_address")

        msg = MIMEText(message)
        msg["Subject"] = title
        msg["From"] = from_addr
        msg["To"] = to_addr

        # Run SMTP in a thread to avoid blocking the event loop
        import asyncio

        def _do_send() -> None:
            if use_tls:
                with smtplib.SMTP(smtp_server, smtp_port) as server:
                    server.starttls()
                    if username:
                        server.login(username, password)
                    server.send_message(msg)
            else:
                with smtplib.SMTP(smtp_server, smtp_port) as server:
                    if username:
                        server.login(username, password)
                    server.send_message(msg)

        await asyncio.get_event_loop().run_in_executor(None, _do_send)

    async def _send_ha(
        self, config: dict[str, Any], title: str, message: str
    ) -> None:
        """Send notification via Home Assistant's notify service."""
        from backend.services.ha_client import get_client

        client = get_client()
        if client is None:
            raise RuntimeError("Home Assistant client not configured")

        service = config.get("ha_notify_service", "notify")
        await client.send_notification(service=service, message=message, title=title)

    async def _log_history(
        self,
        channel_id: str,
        event_type: str,
        title: str,
        message: str,
        status: str,
        error_message: str | None,
    ) -> None:
        """Write a notification send attempt to the history table."""
        try:
            async with get_db() as db:
                await db.execute(
                    """
                    INSERT INTO notification_history
                        (channel, event_type, title, message, status, error_message, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        channel_id,
                        event_type,
                        title,
                        message,
                        status,
                        error_message,
                        datetime.now(timezone.utc).isoformat(),
                    ),
                )
        except Exception as exc:
            logger.warning("Failed to log notification history: %s", exc)


# ------------------------------------------------------------------
# Singleton
# ------------------------------------------------------------------

_instance: NotificationService | None = None


async def get_service() -> NotificationService:
    """Return (or create and initialize) the NotificationService singleton."""
    global _instance
    if _instance is None:
        _instance = NotificationService()
        await _instance.load_channels()
    return _instance


async def reload_service() -> NotificationService:
    """Force reload channels/rules from the database."""
    global _instance
    _instance = NotificationService()
    await _instance.load_channels()
    return _instance
