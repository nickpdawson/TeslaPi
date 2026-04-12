"""WireGuard tunnel management for TeslaPi.

Manages the ``wg-teslapi`` interface used to tunnel back to the home
network (e.g. your home firewall) when the Pi is on a non-home
network such as a mobile hotspot.

In dev mode every method returns realistic mock data.
"""

import logging
import os
import re
import textwrap
from pathlib import Path

from backend.config import settings
from backend.models.schemas import WireGuardConfig, WireGuardStatus
from backend.services import script_runner

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

WG_INTERFACE = "wg-teslapi"
WG_CONFIG_DIR = Path("/etc/wireguard")
WG_CONFIG_PATH = WG_CONFIG_DIR / f"{WG_INTERFACE}.conf"
WG_PRIVATE_KEY_PATH = WG_CONFIG_DIR / "private.key"
WG_PUBLIC_KEY_PATH = WG_CONFIG_DIR / "public.key"

# Auto-connect dispatcher config (read by the NM dispatcher script)
AUTO_CONFIG_DIR = Path("/mutable/teslapi")
AUTO_CONFIG_PATH = AUTO_CONFIG_DIR / "wireguard-auto.conf"

# NetworkManager dispatcher script
DISPATCHER_DIR = Path("/etc/NetworkManager/dispatcher.d")
DISPATCHER_SCRIPT = DISPATCHER_DIR / "99-wireguard-teslapi"


# ---------------------------------------------------------------------------
# Mock data
# ---------------------------------------------------------------------------


def _mock_status() -> WireGuardStatus:
    return WireGuardStatus(
        installed=True,
        configured=True,
        active=False,
        interface=WG_INTERFACE,
        address="192.168.7.3/32",
        peer_endpoint="203.0.113.1:51820",
        last_handshake=None,
        transfer_rx=None,
        transfer_tx=None,
        allowed_ips="10.0.0.0/16, 172.16.0.0/16",
        auto_connect=False,
        only_non_home=True,
        home_ssid="HomeWiFi",
    )


def _mock_config() -> WireGuardConfig:
    return WireGuardConfig(
        private_key="(hidden)",
        address="192.168.7.3/32",
        dns="192.168.1.1",
        peer_public_key="aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789+ab=",
        peer_endpoint="203.0.113.1:51820",
        allowed_ips="10.0.0.0/16, 172.16.0.0/16",
        persistent_keepalive=25,
    )


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _parse_transfer(value: str) -> int | None:
    """Parse a WireGuard transfer string like '1.23 MiB' to bytes."""
    match = re.match(r"([\d.]+)\s*(B|KiB|MiB|GiB|TiB)", value.strip())
    if not match:
        return None
    amount = float(match.group(1))
    unit = match.group(2)
    multipliers = {"B": 1, "KiB": 1024, "MiB": 1024**2, "GiB": 1024**3, "TiB": 1024**4}
    return int(amount * multipliers.get(unit, 1))


def _read_auto_config() -> dict:
    """Read the auto-connect config file."""
    cfg: dict = {"enabled": False, "only_non_home": True, "home_ssid": ""}
    if settings.dev_mode:
        return {"enabled": False, "only_non_home": True, "home_ssid": "HomeWiFi"}
    try:
        if AUTO_CONFIG_PATH.exists():
            for line in AUTO_CONFIG_PATH.read_text().splitlines():
                line = line.strip()
                if line.startswith("#") or "=" not in line:
                    continue
                key, _, val = line.partition("=")
                key = key.strip().lower()
                val = val.strip().strip('"').strip("'")
                if key == "enabled":
                    cfg["enabled"] = val.lower() == "true"
                elif key == "only_non_home":
                    cfg["only_non_home"] = val.lower() == "true"
                elif key == "home_ssid":
                    cfg["home_ssid"] = val
    except OSError as exc:
        logger.warning("Failed to read auto config: %s", exc)
    return cfg


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


class WireGuardManager:
    """Manages WireGuard tunnel connections."""

    @staticmethod
    async def get_status() -> WireGuardStatus:
        """Get tunnel status: up/down, endpoint, last handshake, transfer stats."""
        if settings.dev_mode:
            return _mock_status()

        status = WireGuardStatus(installed=False, configured=False, active=False)

        # Check if wg binary exists
        result = await script_runner.run("which", ["wg"], timeout=5)
        status.installed = result.returncode == 0

        # Check if config file exists
        status.configured = WG_CONFIG_PATH.exists()

        if not status.installed:
            return status

        # Parse interface address from config
        if status.configured:
            try:
                for line in WG_CONFIG_PATH.read_text().splitlines():
                    if line.strip().lower().startswith("address"):
                        status.address = line.split("=", 1)[1].strip()
                        break
            except OSError:
                pass

        # Check if interface is up
        result = await script_runner.run(
            "wg", ["show", WG_INTERFACE], timeout=10,
        )
        if result.returncode != 0:
            # Interface not active
            auto_cfg = _read_auto_config()
            status.auto_connect = auto_cfg["enabled"]
            status.only_non_home = auto_cfg["only_non_home"]
            status.home_ssid = auto_cfg.get("home_ssid")
            return status

        status.active = True

        # Parse wg show output
        for line in result.stdout.splitlines():
            line = line.strip()
            if line.startswith("endpoint:"):
                status.peer_endpoint = line.split(":", 1)[1].strip()
            elif line.startswith("latest handshake:"):
                status.last_handshake = line.split(":", 1)[1].strip()
            elif line.startswith("transfer:"):
                # "transfer: 1.23 MiB received, 456.78 KiB sent"
                parts = line.split(":", 1)[1].strip()
                rx_match = re.search(r"([\d.]+\s*\S+)\s+received", parts)
                tx_match = re.search(r"([\d.]+\s*\S+)\s+sent", parts)
                if rx_match:
                    status.transfer_rx = _parse_transfer(rx_match.group(1))
                if tx_match:
                    status.transfer_tx = _parse_transfer(tx_match.group(1))
            elif line.startswith("allowed ips:"):
                status.allowed_ips = line.split(":", 1)[1].strip()

        auto_cfg = _read_auto_config()
        status.auto_connect = auto_cfg["enabled"]
        status.only_non_home = auto_cfg["only_non_home"]
        status.home_ssid = auto_cfg.get("home_ssid")

        return status

    @staticmethod
    async def configure(config: WireGuardConfig) -> bool:
        """Write WireGuard config and set up the interface."""
        if settings.dev_mode:
            logger.info("Dev mode: pretending to write WireGuard config")
            return True

        # Validate required fields
        if not config.private_key or not config.peer_public_key or not config.peer_endpoint:
            logger.error("WireGuard config missing required fields")
            return False

        # Build config file content
        iface_section = f"""\
[Interface]
PrivateKey = {config.private_key}
Address = {config.address}"""

        if config.dns:
            iface_section += f"\nDNS = {config.dns}"

        peer_section = f"""\
[Peer]
PublicKey = {config.peer_public_key}
Endpoint = {config.peer_endpoint}
AllowedIPs = {config.allowed_ips}
PersistentKeepalive = {config.persistent_keepalive}"""

        conf_content = f"{iface_section}\n\n{peer_section}\n"

        # Ensure directory exists and write config
        try:
            WG_CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            logger.error("Cannot create wireguard config dir: %s", exc)
            return False

        # Write via sudo tee (config dir is root-owned)
        result = await script_runner.run(
            "bash",
            ["-c", f"echo '{conf_content}' | sudo tee {WG_CONFIG_PATH} > /dev/null && sudo chmod 600 {WG_CONFIG_PATH}"],
            timeout=10,
        )
        if result.returncode != 0:
            logger.error("Failed to write WireGuard config: %s", result.stderr)
            return False

        logger.info("WireGuard config written to %s", WG_CONFIG_PATH)
        return True

    @staticmethod
    async def enable() -> bool:
        """Bring up the WireGuard tunnel."""
        if settings.dev_mode:
            logger.info("Dev mode: pretending to enable WireGuard tunnel")
            return True

        result = await script_runner.run(
            "sudo", ["wg-quick", "up", WG_INTERFACE], timeout=15,
        )
        if result.returncode != 0:
            logger.error("Failed to bring up WireGuard: %s", result.stderr)
            return False
        logger.info("WireGuard tunnel %s is up", WG_INTERFACE)
        return True

    @staticmethod
    async def disable() -> bool:
        """Bring down the WireGuard tunnel."""
        if settings.dev_mode:
            logger.info("Dev mode: pretending to disable WireGuard tunnel")
            return True

        result = await script_runner.run(
            "sudo", ["wg-quick", "down", WG_INTERFACE], timeout=15,
        )
        if result.returncode != 0:
            logger.error("Failed to bring down WireGuard: %s", result.stderr)
            return False
        logger.info("WireGuard tunnel %s is down", WG_INTERFACE)
        return True

    @staticmethod
    async def set_auto_connect(
        enabled: bool,
        only_non_home: bool = True,
        home_ssid: str = "",
    ) -> bool:
        """Configure auto-connect behaviour.

        When *only_non_home* is True the tunnel only activates when the
        connected WiFi SSID does not match *home_ssid*.  A NetworkManager
        dispatcher script handles the actual up/down logic.
        """
        if settings.dev_mode:
            logger.info(
                "Dev mode: pretending to set auto-connect enabled=%s only_non_home=%s home_ssid=%s",
                enabled, only_non_home, home_ssid,
            )
            return True

        # Write the auto config file
        try:
            AUTO_CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            logger.error("Cannot create auto config dir: %s", exc)
            return False

        config_content = textwrap.dedent(f"""\
            # TeslaPi WireGuard auto-connect configuration
            # Managed by TeslaPi -- do not edit manually
            ENABLED={"true" if enabled else "false"}
            ONLY_NON_HOME={"true" if only_non_home else "false"}
            HOME_SSID="{home_ssid}"
        """)

        result = await script_runner.run(
            "bash",
            ["-c", f"echo '{config_content}' | sudo tee {AUTO_CONFIG_PATH} > /dev/null"],
            timeout=10,
        )
        if result.returncode != 0:
            logger.error("Failed to write auto config: %s", result.stderr)
            return False

        # Install or remove the dispatcher script
        if enabled:
            dispatcher_content = textwrap.dedent(f"""\
                #!/bin/bash
                # /etc/NetworkManager/dispatcher.d/99-wireguard-teslapi
                # Auto-manage WireGuard tunnel based on WiFi network
                # Managed by TeslaPi -- do not edit manually

                INTERFACE="$1"
                ACTION="$2"
                WG_INTERFACE="{WG_INTERFACE}"
                CONFIG_FILE="{AUTO_CONFIG_PATH}"

                # Only act on WiFi interface events
                [[ "$INTERFACE" != wlan* ]] && exit 0
                [[ "$ACTION" != "up" && "$ACTION" != "down" ]] && exit 0

                # Read config
                [[ -f "$CONFIG_FILE" ]] || exit 0
                source "$CONFIG_FILE"

                [[ "$ENABLED" != "true" ]] && exit 0

                CURRENT_SSID=$(nmcli -t -f GENERAL.CONNECTION device show "$INTERFACE" 2>/dev/null | cut -d: -f2)

                if [[ "$ACTION" == "up" ]]; then
                    if [[ "$ONLY_NON_HOME" == "true" && "$CURRENT_SSID" == "$HOME_SSID" ]]; then
                        # On home network, bring down WG if running
                        wg-quick down "$WG_INTERFACE" 2>/dev/null
                    else
                        # Not home, bring up WG
                        wg-quick up "$WG_INTERFACE" 2>/dev/null
                    fi
                elif [[ "$ACTION" == "down" ]]; then
                    # WiFi went down, bring down WG too
                    wg-quick down "$WG_INTERFACE" 2>/dev/null
                fi
            """)

            result = await script_runner.run(
                "bash",
                [
                    "-c",
                    f"echo '{dispatcher_content}' | sudo tee {DISPATCHER_SCRIPT} > /dev/null "
                    f"&& sudo chmod 755 {DISPATCHER_SCRIPT}",
                ],
                timeout=10,
            )
            if result.returncode != 0:
                logger.error("Failed to install dispatcher script: %s", result.stderr)
                return False
            logger.info("WireGuard auto-connect dispatcher installed")
        else:
            # Remove dispatcher script
            result = await script_runner.run(
                "sudo", ["rm", "-f", str(DISPATCHER_SCRIPT)], timeout=5,
            )
            if result.returncode != 0:
                logger.warning("Failed to remove dispatcher script: %s", result.stderr)
            logger.info("WireGuard auto-connect dispatcher removed")

        return True

    @staticmethod
    async def generate_keypair() -> dict:
        """Generate a new WireGuard keypair for this Pi.

        Returns a dict with ``private_key`` and ``public_key`` so the user
        can add the public key to their pfSense peer configuration.
        """
        if settings.dev_mode:
            return {
                "private_key": "cDev+PrivateKeyMockData1234567890abcdefg=",
                "public_key": "pDev+PublicKeyMockData01234567890abcdefg=",
            }

        # Generate keypair
        result = await script_runner.run(
            "bash",
            [
                "-c",
                f"umask 077 && sudo mkdir -p {WG_CONFIG_DIR} "
                f"&& wg genkey | sudo tee {WG_PRIVATE_KEY_PATH} | wg pubkey | sudo tee {WG_PUBLIC_KEY_PATH}",
            ],
            timeout=10,
        )
        if result.returncode != 0:
            logger.error("Failed to generate WireGuard keypair: %s", result.stderr)
            return {"error": result.stderr}

        # Read both keys
        priv_result = await script_runner.run(
            "sudo", ["cat", str(WG_PRIVATE_KEY_PATH)], timeout=5,
        )
        pub_result = await script_runner.run(
            "sudo", ["cat", str(WG_PUBLIC_KEY_PATH)], timeout=5,
        )

        private_key = priv_result.stdout.strip() if priv_result.returncode == 0 else ""
        public_key = pub_result.stdout.strip() if pub_result.returncode == 0 else ""

        if not private_key or not public_key:
            return {"error": "Failed to read generated keys"}

        return {"private_key": private_key, "public_key": public_key}

    @staticmethod
    async def get_config() -> WireGuardConfig | None:
        """Read current WireGuard configuration (private key masked)."""
        if settings.dev_mode:
            return _mock_config()

        if not WG_CONFIG_PATH.exists():
            return None

        result = await script_runner.run(
            "sudo", ["cat", str(WG_CONFIG_PATH)], timeout=5,
        )
        if result.returncode != 0:
            logger.error("Failed to read WireGuard config: %s", result.stderr)
            return None

        # Parse the config
        private_key = ""
        address = ""
        dns = None
        peer_public_key = ""
        peer_endpoint = ""
        allowed_ips = ""
        persistent_keepalive = 25

        for line in result.stdout.splitlines():
            line = line.strip()
            if "=" not in line:
                continue
            key, _, val = line.partition("=")
            key = key.strip().lower()
            val = val.strip()

            if key == "privatekey":
                private_key = "(hidden)"
            elif key == "address":
                address = val
            elif key == "dns":
                dns = val
            elif key == "publickey":
                peer_public_key = val
            elif key == "endpoint":
                peer_endpoint = val
            elif key == "allowedips":
                allowed_ips = val
            elif key == "persistentkeepalive":
                try:
                    persistent_keepalive = int(val)
                except ValueError:
                    pass

        if not address and not peer_public_key:
            return None

        return WireGuardConfig(
            private_key=private_key,
            address=address,
            dns=dns,
            peer_public_key=peer_public_key,
            peer_endpoint=peer_endpoint,
            allowed_ips=allowed_ips,
            persistent_keepalive=persistent_keepalive,
        )

    @staticmethod
    async def test_tunnel() -> dict:
        """Test tunnel connectivity by pinging through the WireGuard interface.

        Pings the home gateway (first IP in AllowedIPs) to verify the
        tunnel is functional end-to-end.
        """
        if settings.dev_mode:
            return {
                "success": False,
                "message": "Tunnel is not active (dev mode)",
                "details": "WireGuard interface wg-teslapi is down",
            }

        # Check if the interface is up first
        result = await script_runner.run("wg", ["show", WG_INTERFACE], timeout=5)
        if result.returncode != 0:
            return {
                "success": False,
                "message": "Tunnel is not active",
                "details": f"WireGuard interface {WG_INTERFACE} is not up",
            }

        # Determine a target to ping -- use the gateway from AllowedIPs
        # Default to the pfSense LAN IP
        ping_target = "10.0.1.1"

        config = await WireGuardManager.get_config()
        if config and config.allowed_ips:
            # Use the first network's gateway (.1)
            first_net = config.allowed_ips.split(",")[0].strip()
            # Convert network to gateway: 10.0.0.0/16 -> 10.0.1.1
            net_parts = first_net.split("/")[0].split(".")
            if len(net_parts) == 4:
                net_parts[2] = "1"
                net_parts[3] = "1"
                ping_target = ".".join(net_parts)

        result = await script_runner.run(
            "ping",
            ["-c", "3", "-W", "5", "-I", WG_INTERFACE, ping_target],
            timeout=20,
        )

        if result.returncode == 0:
            # Parse average latency
            avg_ms = ""
            for line in result.stdout.splitlines():
                if "avg" in line:
                    # rtt min/avg/max/mdev = 12.345/15.678/18.901/2.345 ms
                    parts = line.split("=")
                    if len(parts) >= 2:
                        avg_ms = parts[1].strip().split("/")[1] + " ms"
                    break

            return {
                "success": True,
                "message": f"Tunnel is working (ping to {ping_target})",
                "details": f"Average latency: {avg_ms}" if avg_ms else "All pings successful",
                "target": ping_target,
            }
        else:
            return {
                "success": False,
                "message": f"Tunnel test failed (could not reach {ping_target})",
                "details": result.stderr or result.stdout or "No response",
                "target": ping_target,
            }
