"""Home Assistant REST API and MQTT client for TeslaPi state publishing."""

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Any

import httpx

from backend.config import settings
from backend.models.schemas import TeslaPiStatus

logger = logging.getLogger(__name__)

# Try to import paho-mqtt; graceful fallback if not installed
try:
    import paho.mqtt.client as mqtt

    _MQTT_AVAILABLE = True
except ImportError:
    _MQTT_AVAILABLE = False
    logger.info("paho-mqtt not installed; MQTT support disabled")


# Entity definitions: (entity_id, device_class, unit, icon)
_SENSOR_ENTITIES: list[tuple[str, str, str, str]] = [
    ("sensor.teslapi_status", None, None, "mdi:car-connected"),
    ("sensor.teslapi_cam_storage_pct", "data_size", "%", "mdi:harddisk"),
    ("sensor.teslapi_music_storage_pct", "data_size", "%", "mdi:music-box-multiple"),
    ("sensor.teslapi_external_drive_pct", "data_size", "%", "mdi:usb-flash-drive"),
    ("sensor.teslapi_cpu_temp", "temperature", "°C", "mdi:thermometer"),
    ("sensor.teslapi_last_archive", "timestamp", None, "mdi:archive-clock"),
    ("sensor.teslapi_last_music_sync", "timestamp", None, "mdi:sync"),
]

_BINARY_SENSOR_ENTITIES: list[tuple[str, str, str]] = [
    ("binary_sensor.teslapi_online", "connectivity", "mdi:raspberry-pi"),
]

# Interval for background state push (seconds)
_PUSH_INTERVAL = 30


class HAClient:
    """Communicates with a Home Assistant instance via REST and optionally MQTT."""

    def __init__(
        self,
        url: str,
        token: str,
        mqtt_config: dict[str, Any] | None = None,
    ) -> None:
        self.url = url.rstrip("/")
        self.token = token
        self.mqtt_config = mqtt_config
        self._mqtt_client: Any | None = None
        self._mqtt_connected = False

        # Connect MQTT if configured and available
        if mqtt_config and _MQTT_AVAILABLE and mqtt_config.get("broker"):
            self._setup_mqtt(mqtt_config)

    # ------------------------------------------------------------------
    # MQTT helpers
    # ------------------------------------------------------------------

    def _setup_mqtt(self, cfg: dict[str, Any]) -> None:
        """Initialize paho-mqtt client (non-blocking)."""
        try:
            client = mqtt.Client(client_id="teslapi", protocol=mqtt.MQTTv311)
            username = cfg.get("username")
            password = cfg.get("password")
            if username:
                client.username_pw_set(username, password or "")
            client.on_connect = self._on_mqtt_connect
            client.on_disconnect = self._on_mqtt_disconnect
            broker = cfg.get("broker", "localhost")
            port = int(cfg.get("port", 1883))
            client.connect_async(broker, port, keepalive=60)
            client.loop_start()
            self._mqtt_client = client
            logger.info("MQTT client connecting to %s:%d", broker, port)
        except Exception as exc:
            logger.warning("Failed to initialize MQTT: %s", exc)
            self._mqtt_client = None

    def _on_mqtt_connect(self, client: Any, userdata: Any, flags: Any, rc: int) -> None:
        if rc == 0:
            self._mqtt_connected = True
            logger.info("MQTT connected")
            self._publish_discovery()
        else:
            logger.warning("MQTT connect failed with rc=%d", rc)

    def _on_mqtt_disconnect(self, client: Any, userdata: Any, rc: int) -> None:
        self._mqtt_connected = False
        logger.warning("MQTT disconnected (rc=%d)", rc)

    def _publish_discovery(self) -> None:
        """Publish HA MQTT auto-discovery config messages."""
        if not self._mqtt_client or not self._mqtt_connected:
            return

        device_info = {
            "identifiers": ["teslapi"],
            "name": "TeslaPi",
            "manufacturer": "TeslaPi",
            "model": "TeslaPi",
            "sw_version": "1.0",
        }

        for entity_id, device_class, unit, icon in _SENSOR_ENTITIES:
            slug = entity_id.split(".", 1)[1]
            config_topic = f"homeassistant/sensor/teslapi/{slug}/config"
            payload: dict[str, Any] = {
                "name": slug.replace("teslapi_", "TeslaPi ").replace("_", " ").title(),
                "unique_id": f"teslapi_{slug}",
                "state_topic": f"teslapi/{slug}/state",
                "device": device_info,
                "icon": icon,
            }
            if device_class:
                payload["device_class"] = device_class
            if unit:
                payload["unit_of_measurement"] = unit
            self._mqtt_client.publish(config_topic, json.dumps(payload), retain=True)

        for entity_id, device_class, icon in _BINARY_SENSOR_ENTITIES:
            slug = entity_id.split(".", 1)[1]
            config_topic = f"homeassistant/binary_sensor/teslapi/{slug}/config"
            payload = {
                "name": slug.replace("teslapi_", "TeslaPi ").replace("_", " ").title(),
                "unique_id": f"teslapi_{slug}",
                "state_topic": f"teslapi/{slug}/state",
                "device_class": device_class,
                "device": device_info,
                "icon": icon,
                "payload_on": "on",
                "payload_off": "off",
            }
            self._mqtt_client.publish(config_topic, json.dumps(payload), retain=True)

        logger.info("MQTT discovery messages published")

    def _mqtt_publish_state(self, entity_id: str, state: str) -> None:
        """Publish a state update via MQTT."""
        if not self._mqtt_client or not self._mqtt_connected:
            return
        slug = entity_id.split(".", 1)[1]
        topic = f"teslapi/{slug}/state"
        self._mqtt_client.publish(topic, state, retain=True)

    def disconnect_mqtt(self) -> None:
        """Cleanly stop the MQTT client."""
        if self._mqtt_client:
            try:
                self._mqtt_client.loop_stop()
                self._mqtt_client.disconnect()
            except Exception:
                pass

    # ------------------------------------------------------------------
    # REST API helpers
    # ------------------------------------------------------------------

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/json",
        }

    async def test_connection(self) -> dict[str, Any]:
        """Test the connection to Home Assistant. Returns version and name."""
        if settings.dev_mode:
            logger.info("Dev mode: simulating HA connection test to %s", self.url)
            return {
                "message": "API running.",
                "version": "2026.3.0",
                "installation_type": "Home Assistant OS",
                "dev_mode": True,
            }

        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{self.url}/api/", headers=self._headers())
            resp.raise_for_status()
            return resp.json()

    async def update_entity(
        self,
        entity_id: str,
        state: str,
        attributes: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        """Update (or create) an entity state in Home Assistant."""
        if settings.dev_mode:
            logger.debug(
                "Dev mode: would update HA entity %s = %s (attrs=%s)",
                entity_id, state, attributes,
            )
            return {"entity_id": entity_id, "state": state, "dev_mode": True}

        payload: dict[str, Any] = {"state": state}
        if attributes:
            payload["attributes"] = attributes

        # Also publish via MQTT if available
        self._mqtt_publish_state(entity_id, state)

        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                f"{self.url}/api/states/{entity_id}",
                headers=self._headers(),
                json=payload,
            )
            resp.raise_for_status()
            return resp.json()

    async def push_all_states(self, status: TeslaPiStatus) -> None:
        """Push all TeslaPi entity states to Home Assistant at once."""
        # Build a mapping of entity_id -> (state, attributes)
        entities: list[tuple[str, str, dict[str, Any]]] = []

        # Status
        entities.append((
            "sensor.teslapi_status",
            status.state.value,
            {"friendly_name": "TeslaPi Status"},
        ))

        # Storage percentages — find by label
        storage_map = {s.label.lower(): s for s in status.storage}

        cam = storage_map.get("dashcam")
        if cam:
            entities.append((
                "sensor.teslapi_cam_storage_pct",
                str(round(cam.percent_used, 1)),
                {
                    "friendly_name": "TeslaPi Dashcam Storage",
                    "unit_of_measurement": "%",
                    "used_bytes": cam.used_bytes,
                    "total_bytes": cam.total_bytes,
                },
            ))

        music = storage_map.get("music")
        if music:
            entities.append((
                "sensor.teslapi_music_storage_pct",
                str(round(music.percent_used, 1)),
                {
                    "friendly_name": "TeslaPi Music Storage",
                    "unit_of_measurement": "%",
                    "used_bytes": music.used_bytes,
                    "total_bytes": music.total_bytes,
                },
            ))

        ext = storage_map.get("external drive")
        if ext:
            entities.append((
                "sensor.teslapi_external_drive_pct",
                str(round(ext.percent_used, 1)),
                {
                    "friendly_name": "TeslaPi External Drive",
                    "unit_of_measurement": "%",
                    "used_bytes": ext.used_bytes,
                    "total_bytes": ext.total_bytes,
                },
            ))

        # CPU temp
        if status.system.cpu_temp_celsius > 0:
            entities.append((
                "sensor.teslapi_cpu_temp",
                str(round(status.system.cpu_temp_celsius, 1)),
                {
                    "friendly_name": "TeslaPi CPU Temperature",
                    "unit_of_measurement": "°C",
                    "device_class": "temperature",
                },
            ))

        # Last archive timestamp
        if status.archive.last_archive_at:
            entities.append((
                "sensor.teslapi_last_archive",
                status.archive.last_archive_at.isoformat(),
                {
                    "friendly_name": "TeslaPi Last Archive",
                    "device_class": "timestamp",
                    "clips": status.archive.last_archive_clips,
                    "bytes": status.archive.last_archive_bytes,
                },
            ))

        # Last music sync
        if status.music.last_sync_at:
            entities.append((
                "sensor.teslapi_last_music_sync",
                status.music.last_sync_at.isoformat(),
                {
                    "friendly_name": "TeslaPi Last Music Sync",
                    "device_class": "timestamp",
                },
            ))

        # Binary sensor: online
        entities.append((
            "binary_sensor.teslapi_online",
            "on",
            {"friendly_name": "TeslaPi Online", "device_class": "connectivity"},
        ))

        # Push all entities
        for entity_id, state, attrs in entities:
            try:
                await self.update_entity(entity_id, state, attrs)
            except Exception as exc:
                logger.warning("Failed to push %s to HA: %s", entity_id, exc)

    async def send_notification(
        self, service: str, message: str, title: str = ""
    ) -> dict[str, Any] | None:
        """Send a notification via Home Assistant's notify service."""
        if settings.dev_mode:
            logger.info(
                "Dev mode: would send HA notification via notify.%s: %s - %s",
                service, title, message,
            )
            return {"service": service, "title": title, "dev_mode": True}

        payload: dict[str, Any] = {"message": message}
        if title:
            payload["title"] = title

        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                f"{self.url}/api/services/notify/{service}",
                headers=self._headers(),
                json=payload,
            )
            resp.raise_for_status()
            return resp.json()


# ------------------------------------------------------------------
# Singleton management and background loop
# ------------------------------------------------------------------

_instance: HAClient | None = None
_push_task: asyncio.Task | None = None


def get_client() -> HAClient | None:
    """Return the current HAClient singleton, or None if not configured."""
    return _instance


def configure_client(
    url: str,
    token: str,
    mqtt_config: dict[str, Any] | None = None,
) -> HAClient:
    """Create or reconfigure the HAClient singleton."""
    global _instance
    if _instance:
        _instance.disconnect_mqtt()
    _instance = HAClient(url=url, token=token, mqtt_config=mqtt_config)
    return _instance


async def _push_loop() -> None:
    """Background loop that pushes state to HA every _PUSH_INTERVAL seconds."""
    # Import here to avoid circular imports
    from backend.routers.status import get_status

    while True:
        try:
            await asyncio.sleep(_PUSH_INTERVAL)
            client = get_client()
            if client is None:
                continue
            status = await get_status()
            await client.push_all_states(status)
            logger.debug("HA state push completed")
        except asyncio.CancelledError:
            logger.info("HA push loop cancelled")
            break
        except Exception as exc:
            logger.warning("HA push loop error: %s", exc)


def start_push_loop() -> None:
    """Start the background HA state push task."""
    global _push_task
    if _push_task and not _push_task.done():
        return
    _push_task = asyncio.create_task(_push_loop())
    logger.info("HA background push loop started (interval=%ds)", _PUSH_INTERVAL)


def stop_push_loop() -> None:
    """Stop the background HA state push task."""
    global _push_task
    if _push_task and not _push_task.done():
        _push_task.cancel()
        _push_task = None
        logger.info("HA background push loop stopped")
