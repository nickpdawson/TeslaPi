"""Network management API: WiFi connections and WireGuard tunnel."""

import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.models.schemas import (
    NetworkStatus,
    WireGuardConfig,
    WireGuardStatus,
    WiFiAddRequest,
    WiFiConnection,
    WiFiNetwork,
)
from backend.services.network_manager import NetworkManager
from backend.services.wireguard_manager import WireGuardManager

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/network")

# ---------------------------------------------------------------------------
# Request models (router-local)
# ---------------------------------------------------------------------------


class PriorityUpdate(BaseModel):
    priority: int


class AutoConnectRequest(BaseModel):
    enabled: bool
    only_non_home: bool = True
    home_ssid: str = ""


# ---------------------------------------------------------------------------
# Combined status
# ---------------------------------------------------------------------------


@router.get("/status")
async def get_network_status() -> dict:
    """Overall network status combining WiFi and WireGuard info."""
    wifi_status = await NetworkManager.get_status()
    wg_status = await WireGuardManager.get_status()
    return {
        "wifi": wifi_status.model_dump(),
        "wireguard": wg_status.model_dump(),
    }


# ---------------------------------------------------------------------------
# WiFi endpoints
# ---------------------------------------------------------------------------


@router.get("/wifi/connections", response_model=list[WiFiConnection])
async def list_wifi_connections() -> list[WiFiConnection]:
    """List all saved WiFi connection profiles, sorted by priority."""
    return await NetworkManager.list_connections()


@router.get("/wifi/scan", response_model=list[WiFiNetwork])
async def scan_wifi_networks() -> list[WiFiNetwork]:
    """Scan for available WiFi networks."""
    return await NetworkManager.scan()


@router.post("/wifi/add")
async def add_wifi_connection(req: WiFiAddRequest) -> dict:
    """Add a new WiFi connection profile."""
    if not req.ssid or not req.password:
        raise HTTPException(status_code=400, detail="SSID and password are required")

    ok = await NetworkManager.add_connection(
        ssid=req.ssid,
        password=req.password,
        priority=req.priority,
        hidden=req.hidden,
        auto_connect=req.auto_connect,
    )
    if not ok:
        raise HTTPException(status_code=500, detail=f"Failed to add WiFi connection '{req.ssid}'")

    return {"success": True, "ssid": req.ssid}


@router.delete("/wifi/{ssid}")
async def remove_wifi_connection(ssid: str) -> dict:
    """Remove a saved WiFi connection profile."""
    ok = await NetworkManager.remove_connection(ssid)
    if not ok:
        raise HTTPException(status_code=500, detail=f"Failed to remove WiFi connection '{ssid}'")
    return {"success": True, "ssid": ssid}


@router.put("/wifi/{ssid}/priority")
async def update_wifi_priority(ssid: str, body: PriorityUpdate) -> dict:
    """Update the autoconnect priority for a saved WiFi connection."""
    ok = await NetworkManager.update_priority(ssid, body.priority)
    if not ok:
        raise HTTPException(status_code=500, detail=f"Failed to update priority for '{ssid}'")
    return {"success": True, "ssid": ssid, "priority": body.priority}


@router.post("/wifi/{ssid}/connect")
async def connect_wifi(ssid: str) -> dict:
    """Manually connect to a specific saved WiFi network."""
    ok = await NetworkManager.connect(ssid)
    if not ok:
        raise HTTPException(status_code=500, detail=f"Failed to connect to '{ssid}'")
    return {"success": True, "ssid": ssid}


@router.post("/wifi/disconnect")
async def disconnect_wifi() -> dict:
    """Disconnect from the current WiFi network."""
    ok = await NetworkManager.disconnect()
    if not ok:
        raise HTTPException(status_code=500, detail="Failed to disconnect WiFi")
    return {"success": True}


# ---------------------------------------------------------------------------
# WireGuard endpoints
# ---------------------------------------------------------------------------


@router.get("/wireguard/status", response_model=WireGuardStatus)
async def get_wireguard_status() -> WireGuardStatus:
    """Get WireGuard tunnel status."""
    return await WireGuardManager.get_status()


@router.put("/wireguard/config")
async def save_wireguard_config(config: WireGuardConfig) -> dict:
    """Save WireGuard tunnel configuration."""
    ok = await WireGuardManager.configure(config)
    if not ok:
        raise HTTPException(status_code=500, detail="Failed to save WireGuard configuration")
    return {"success": True}


@router.get("/wireguard/config")
async def get_wireguard_config() -> dict:
    """Get current WireGuard configuration (private key masked)."""
    config = await WireGuardManager.get_config()
    if config is None:
        return {"configured": False}
    return {"configured": True, "config": config.model_dump()}


@router.post("/wireguard/enable")
async def enable_wireguard() -> dict:
    """Bring up the WireGuard tunnel."""
    ok = await WireGuardManager.enable()
    if not ok:
        raise HTTPException(status_code=500, detail="Failed to enable WireGuard tunnel")
    return {"success": True}


@router.post("/wireguard/disable")
async def disable_wireguard() -> dict:
    """Bring down the WireGuard tunnel."""
    ok = await WireGuardManager.disable()
    if not ok:
        raise HTTPException(status_code=500, detail="Failed to disable WireGuard tunnel")
    return {"success": True}


@router.post("/wireguard/auto")
async def set_wireguard_auto_connect(body: AutoConnectRequest) -> dict:
    """Configure WireGuard auto-connect behaviour.

    When *only_non_home* is True, the tunnel only comes up when the Pi
    is connected to a WiFi network whose SSID does not match *home_ssid*.
    """
    ok = await WireGuardManager.set_auto_connect(
        enabled=body.enabled,
        only_non_home=body.only_non_home,
        home_ssid=body.home_ssid,
    )
    if not ok:
        raise HTTPException(status_code=500, detail="Failed to configure WireGuard auto-connect")
    return {"success": True, "enabled": body.enabled}


@router.post("/wireguard/generate-keys")
async def generate_wireguard_keys() -> dict:
    """Generate a new WireGuard keypair for this Pi.

    Returns both keys so the public key can be added to the pfSense
    WireGuard peer configuration.
    """
    result = await WireGuardManager.generate_keypair()
    if "error" in result:
        raise HTTPException(status_code=500, detail=result["error"])
    return result


@router.post("/wireguard/test")
async def test_wireguard_tunnel() -> dict:
    """Test WireGuard tunnel connectivity by pinging through the interface."""
    return await WireGuardManager.test_tunnel()
