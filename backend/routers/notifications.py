"""Notification management API endpoints."""

import json
import logging
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from backend.config import settings
from backend.database import get_db
from backend.services import notification_service
from backend.services.notification_service import EVENT_TYPES


class AdHocTestRequest(BaseModel):
    """An unsaved channel to test from the Settings form before creating it."""
    type: str
    config: dict[str, Any] = {}

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/notifications")


# ------------------------------------------------------------------
# Channel CRUD
# ------------------------------------------------------------------


@router.get("/channels")
async def list_channels() -> dict[str, Any]:
    """List all configured notification channels."""
    async with get_db() as db:
        cursor = await db.execute(
            "SELECT id, enabled, config_json, updated_at FROM notification_channels"
        )
        rows = await cursor.fetchall()

    channels = []
    for row in rows:
        config = json.loads(row["config_json"]) if row["config_json"] else {}
        # Mask sensitive fields in config
        sanitized = _sanitize_config(config)
        channels.append({
            "id": row["id"],
            "enabled": bool(row["enabled"]),
            "config": sanitized,
            "updated_at": row["updated_at"],
        })

    return {"channels": channels, "count": len(channels)}


@router.put("/channels/{channel_id}")
async def upsert_channel(channel_id: str, body: dict[str, Any]) -> dict[str, Any]:
    """Create or update a notification channel.

    Body should contain:
      - enabled: bool
      - config: dict with channel-specific settings (type, credentials, etc.)
    """
    enabled = body.get("enabled", False)
    config = body.get("config", {})

    if not config:
        raise HTTPException(status_code=400, detail="Channel config is required")

    async with get_db() as db:
        # list_channels masks secrets to the mask; the form prefills that and sends it
        # back. Merge against the stored config so an echoed mask keeps the real secret
        # instead of overwriting it (and a mask with nothing stored is dropped, never
        # persisted literally).
        cursor = await db.execute(
            "SELECT config_json FROM notification_channels WHERE id = ?", (channel_id,)
        )
        row = await cursor.fetchone()
        existing = json.loads(row["config_json"]) if row and row["config_json"] else {}
        merged = _merge_preserving_secrets(config, existing)
        merged_json = json.dumps(merged)

        await db.execute(
            """
            INSERT INTO notification_channels (id, enabled, config_json, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                enabled = excluded.enabled,
                config_json = excluded.config_json,
                updated_at = excluded.updated_at
            """,
            (
                channel_id,
                1 if enabled else 0,
                merged_json,
                datetime.now(timezone.utc).isoformat(),
            ),
        )

    # Reload the notification service to pick up changes
    await notification_service.reload_service()

    return {"status": "saved", "id": channel_id, "enabled": enabled}


@router.delete("/channels/{channel_id}")
async def delete_channel(channel_id: str) -> dict[str, Any]:
    """Delete a notification channel and its associated rules."""
    async with get_db() as db:
        cursor = await db.execute(
            "DELETE FROM notification_channels WHERE id = ?", (channel_id,)
        )
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Channel not found")

        # Also remove rules referencing this channel
        await db.execute(
            "DELETE FROM notification_rules WHERE channel_id = ?", (channel_id,)
        )

    await notification_service.reload_service()
    return {"status": "deleted", "id": channel_id}


@router.post("/test")
async def test_adhoc(body: AdHocTestRequest) -> dict[str, Any]:
    """Test an unsaved channel config (Settings form, before the channel is created).
    Returns {ok, message} — the shape the UI reads."""
    svc = await notification_service.get_service()
    result = await svc.test_adhoc(body.type, body.config)
    ok = result.get("status") != "error"
    return {
        "ok": ok,
        "message": (result.get("error") or "Test notification sent.") if not ok
        else "Test notification sent.",
    }


@router.post("/test/{channel_id}")
async def test_channel(channel_id: str) -> dict[str, Any]:
    """Send a test notification through a specific channel."""
    svc = await notification_service.get_service()
    result = await svc.send_to_channel(
        channel_id=channel_id,
        title="TeslaPi Test",
        message=f"Test notification sent at {datetime.now(timezone.utc).isoformat()}",
    )

    if result["status"] == "error":
        raise HTTPException(
            status_code=500,
            detail=f"Test notification failed: {result.get('error', 'unknown')}",
        )

    return result


# ------------------------------------------------------------------
# Notification history
# ------------------------------------------------------------------


@router.get("/history")
async def get_history(
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    event_type: str | None = Query(default=None),
) -> dict[str, Any]:
    """Return paginated notification history."""
    async with get_db() as db:
        # Build query with optional event_type filter
        where = ""
        params: list[Any] = []
        if event_type:
            where = "WHERE event_type = ?"
            params.append(event_type)

        # Total count
        count_cursor = await db.execute(
            f"SELECT COUNT(*) as cnt FROM notification_history {where}", params
        )
        count_row = await count_cursor.fetchone()
        total = count_row["cnt"] if count_row else 0

        # Fetch page
        params.extend([limit, offset])
        cursor = await db.execute(
            f"""
            SELECT id, channel, event_type, title, message, status, error_message, created_at
            FROM notification_history
            {where}
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?
            """,
            params,
        )
        rows = await cursor.fetchall()

    items = [
        {
            "id": row["id"],
            "channel": row["channel"],
            "event_type": row["event_type"],
            "title": row["title"],
            "message": row["message"],
            "status": row["status"],
            "error_message": row["error_message"],
            "created_at": row["created_at"],
        }
        for row in rows
    ]

    return {
        "items": items,
        "total": total,
        "limit": limit,
        "offset": offset,
    }


# ------------------------------------------------------------------
# Event routing rules
# ------------------------------------------------------------------


@router.get("/rules")
async def get_rules() -> dict[str, Any]:
    """Return all event routing rules grouped by event type."""
    async with get_db() as db:
        cursor = await db.execute(
            "SELECT event_type, channel_id, enabled FROM notification_rules ORDER BY event_type"
        )
        rows = await cursor.fetchall()

    rules: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        rules.setdefault(row["event_type"], []).append({
            "channel_id": row["channel_id"],
            "enabled": bool(row["enabled"]),
        })

    return {"rules": rules, "event_types": EVENT_TYPES}


@router.put("/rules")
async def update_rules(body: dict[str, Any]) -> dict[str, Any]:
    """Update event routing rules.

    Body should be:
      { "rules": { "event_type": [ {"channel_id": "...", "enabled": true}, ... ] } }
    """
    rules = body.get("rules", {})
    if not rules:
        raise HTTPException(status_code=400, detail="No rules provided")

    count = 0
    async with get_db() as db:
        for event_type, channels in rules.items():
            if event_type not in EVENT_TYPES:
                logger.warning("Ignoring unknown event type: %s", event_type)
                continue

            # Remove existing rules for this event type
            await db.execute(
                "DELETE FROM notification_rules WHERE event_type = ?",
                (event_type,),
            )

            # Insert new rules
            for entry in channels:
                channel_id = entry.get("channel_id")
                enabled = entry.get("enabled", True)
                if channel_id:
                    await db.execute(
                        """
                        INSERT INTO notification_rules (event_type, channel_id, enabled)
                        VALUES (?, ?, ?)
                        """,
                        (event_type, channel_id, 1 if enabled else 0),
                    )
                    count += 1

    await notification_service.reload_service()
    return {"status": "saved", "rules_count": count}


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------

_SENSITIVE_KEYS = {"password", "token", "secret", "key", "api_key", "smtp_password", "mqtt_password"}
_MASK = "********"


def _is_sensitive(key: str) -> bool:
    return any(sensitive in key.lower() for sensitive in _SENSITIVE_KEYS)


def _sanitize_config(config: dict[str, Any]) -> dict[str, Any]:
    """Mask sensitive values in a channel config dict."""
    sanitized = {}
    for k, v in config.items():
        if _is_sensitive(k) and v:
            sanitized[k] = _MASK
        else:
            sanitized[k] = v
    return sanitized


def _merge_preserving_secrets(
    incoming: dict[str, Any], existing: dict[str, Any]
) -> dict[str, Any]:
    """Merge an incoming channel config over the stored one, keeping real secrets.

    A sensitive field whose incoming value is the mask means "unchanged": keep the
    stored value, or drop the field if nothing is stored (so the literal mask is
    never persisted as a credential). Every other field is taken as sent.
    """
    merged: dict[str, Any] = {}
    for k, v in incoming.items():
        if _is_sensitive(k) and v == _MASK:
            if existing.get(k):
                merged[k] = existing[k]
            # else: omit — don't store the mask as if it were the secret
        else:
            merged[k] = v
    return merged
