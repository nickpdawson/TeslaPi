"""Home Assistant integration API endpoints."""

import json
import logging
import re
from typing import Any

from fastapi import APIRouter, HTTPException

from backend.config import settings
from backend.database import get_db
from backend.models.schemas import HAConfig
from backend.services import ha_client

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/ha")

_TOKEN_MASK = "********"


def _mask_token(token: str) -> str:
    """Show only first 4 and last 4 characters of a token."""
    if len(token) <= 12:
        return _TOKEN_MASK
    return token[:4] + "..." + token[-4:]


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
async def test_ha_connection() -> dict[str, Any]:
    """Test the connection to the configured Home Assistant instance."""
    config = await _load_ha_config()
    if not config.url or not config.token:
        raise HTTPException(
            status_code=400,
            detail="Home Assistant URL and token must be configured first",
        )

    try:
        client = ha_client.HAClient(url=config.url, token=config.token)
        result = await client.test_connection()
        return {
            "status": "ok",
            "ha_version": result.get("version", "unknown"),
            "ha_name": result.get("location_name", result.get("installation_type", "")),
            "message": result.get("message", ""),
        }
    except Exception as exc:
        logger.warning("HA connection test failed: %s", exc)
        raise HTTPException(status_code=502, detail=f"Connection failed: {exc}")


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
