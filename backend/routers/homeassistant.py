"""Home Assistant integration API endpoints."""

import json
import logging
import re
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.config import settings
from backend.database import get_db
from backend.models.schemas import HAConfig
from backend.services import ha_client


class HATestRequest(BaseModel):
    """Optional url/token to test before saving; falls back to the saved config."""
    url: str | None = None
    token: str | None = None

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/ha")

_TOKEN_MASK = "********"


def _mask_token(token: str) -> str:
    """Show only first 4 and last 4 characters of a token."""
    if len(token) <= 12:
        return _TOKEN_MASK
    return token[:4] + "..." + token[-4:]


def _looks_masked(token: str) -> bool:
    """True if a non-empty token is one of the masked forms produced by _mask_token
    (the "abcd...wxyz" ellipsis form or the full "********"). A real HA long-lived
    JWT never contains three consecutive dots, so this won't match a genuine token.
    An empty string is NOT masked — that means the user deliberately cleared it."""
    return bool(token) and (token == _TOKEN_MASK or "..." in token)


def _preserve_ha_secrets(incoming: HAConfig, saved: HAConfig) -> HAConfig:
    """The Settings form loads token + mqtt_password masked and echoes them back on
    save. When a secret comes in masked (unchanged), keep the stored value so a save
    doesn't overwrite the real credential with the mask (which would also break the
    live client, since configure_client uses body.token)."""
    if _looks_masked(incoming.token):
        incoming.token = saved.token
    if incoming.mqtt_password == _TOKEN_MASK:
        incoming.mqtt_password = saved.mqtt_password
    return incoming


async def _load_ha_config() -> HAConfig:
    """Load HA configuration from the database config store."""
    async with get_db() as db:
        cursor = await db.execute(
            "SELECT config_json FROM notification_channels WHERE id = 'ha_integration'"
        )
        row = await cursor.fetchone()
        if row and row["config_json"]:
            data = json.loads(row["config_json"])
            return HAConfig(**data)
    return HAConfig()


async def _save_ha_config(config: HAConfig) -> None:
    """Persist HA configuration to the database."""
    async with get_db() as db:
        await db.execute(
            """
            INSERT INTO notification_channels (id, enabled, config_json, updated_at)
            VALUES ('ha_integration', ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(id) DO UPDATE SET
                enabled = excluded.enabled,
                config_json = excluded.config_json,
                updated_at = CURRENT_TIMESTAMP
            """,
            (1 if config.enabled else 0, config.model_dump_json()),
        )


@router.get("/config")
async def get_ha_config() -> dict[str, Any]:
    """Return current Home Assistant configuration with token masked."""
    config = await _load_ha_config()
    result = config.model_dump()
    if result["token"]:
        result["token"] = _mask_token(config.token)
    if result["mqtt_password"]:
        result["mqtt_password"] = _TOKEN_MASK
    return {"config": result}


@router.put("/config")
async def update_ha_config(body: HAConfig) -> dict[str, Any]:
    """Save Home Assistant configuration and (re)configure the client."""
    # Preserve secrets the form echoed back masked, so a save never clobbers the
    # stored token/mqtt_password (and never configures the client with the mask).
    saved = await _load_ha_config()
    body = _preserve_ha_secrets(body, saved)
    await _save_ha_config(body)

    # Reconfigure the HA client singleton
    mqtt_config: dict[str, Any] | None = None
    if body.mqtt_broker:
        mqtt_config = {
            "broker": body.mqtt_broker,
            "port": body.mqtt_port,
            "username": body.mqtt_username,
            "password": body.mqtt_password,
        }

    if body.enabled and body.url and body.token:
        client = ha_client.configure_client(
            url=body.url, token=body.token, mqtt_config=mqtt_config
        )
        ha_client.start_push_loop()
        logger.info("HA client configured and push loop started")
    else:
        ha_client.stop_push_loop()
        logger.info("HA integration disabled")

    return {"status": "saved", "enabled": body.enabled}


@router.post("/test")
async def test_ha_connection(body: HATestRequest | None = None) -> dict[str, Any]:
    """Test a Home Assistant connection.

    Uses the url/token in the request (so the Settings form can test before saving);
    falls back to the saved config when they're omitted. Returns the shape the UI
    reads: {ok, message, haVersion, instanceName}.
    """
    url = (body.url if body else None)
    token = (body.token if body else None)

    # The Settings form loads the token MASKED, so a retest of saved credentials
    # sends back the mask, not the real token. Treat an empty or masked token (the
    # "abcd...wxyz" or "********" forms — a real HA JWT never contains "...") as
    # "use the saved credential".
    token_is_masked = (not token) or token == _TOKEN_MASK or "..." in token
    if token_is_masked or not url:
        cfg = await _load_ha_config()
        if not url:
            url = cfg.url
        if token_is_masked:
            # SECURITY: only reuse the saved token against the SAVED url. Otherwise a
            # caller could send a masked token + their own url and receive the real
            # saved token in the Authorization header — exfiltration. Any mismatch is
            # refused, INCLUDING when the saved url is empty (so an attacker url can't
            # slip past a falsy saved url).
            if url != cfg.url:
                return {
                    "ok": False,
                    "message": "Enter the Home Assistant token to test a different URL.",
                }
            token = cfg.token

    if not url or not token:
        return {"ok": False, "message": "Home Assistant URL and token are required."}

    try:
        client = ha_client.HAClient(url=url, token=token)
        result = await client.test_connection()
        return {
            "ok": True,
            "message": result.get("message", "Connected successfully."),
            "haVersion": result.get("version", "unknown"),
            "instanceName": result.get("location_name", result.get("installation_type", "")),
        }
    except Exception as exc:
        logger.warning("HA connection test failed: %s", exc)
        return {"ok": False, "message": f"Connection failed: {exc}"}


@router.get("/entities")
async def list_entities() -> dict[str, Any]:
    """List all registered TeslaPi entities and their current values."""
    entities: list[dict[str, Any]] = []

    for entity_id, device_class, unit, icon in ha_client._SENSOR_ENTITIES:
        entities.append({
            "entity_id": entity_id,
            "type": "sensor",
            "device_class": device_class,
            "unit": unit,
            "icon": icon,
        })

    for entity_id, device_class, icon in ha_client._BINARY_SENSOR_ENTITIES:
        entities.append({
            "entity_id": entity_id,
            "type": "binary_sensor",
            "device_class": device_class,
            "icon": icon,
        })

    return {"entities": entities, "count": len(entities)}


@router.post("/push")
async def force_push() -> dict[str, Any]:
    """Force an immediate push of all TeslaPi states to Home Assistant."""
    client = ha_client.get_client()
    if client is None:
        # Try to auto-configure from saved config
        config = await _load_ha_config()
        if config.enabled and config.url and config.token:
            mqtt_config: dict[str, Any] | None = None
            if config.mqtt_broker:
                mqtt_config = {
                    "broker": config.mqtt_broker,
                    "port": config.mqtt_port,
                    "username": config.mqtt_username,
                    "password": config.mqtt_password,
                }
            client = ha_client.configure_client(
                url=config.url, token=config.token, mqtt_config=mqtt_config
            )
        else:
            raise HTTPException(
                status_code=400,
                detail="Home Assistant is not configured or not enabled",
            )

    # Get current status and push
    from backend.routers.status import get_status

    status = await get_status()
    await client.push_all_states(status)
    return {"status": "pushed", "entity_count": len(ha_client._SENSOR_ENTITIES) + len(ha_client._BINARY_SENSOR_ENTITIES)}
