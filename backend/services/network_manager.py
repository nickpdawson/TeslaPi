"""WiFi connection management via NetworkManager (nmcli).

Provides async methods for listing, adding, removing, and prioritising
WiFi connections on Raspberry Pi OS Bookworm which ships NetworkManager
by default.  In dev mode every method returns realistic mock data so the
frontend can be developed without hardware.
"""

import logging
from dataclasses import dataclass

from backend.config import settings
from backend.models.schemas import NetworkStatus, WiFiConnection, WiFiNetwork
from backend.services import script_runner

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_WIFI_INTERFACE = "wlan0"


def _dbm_to_percent(dbm: int) -> int:
    """Convert dBm signal strength to a 0-100 percentage."""
    if dbm >= -50:
        return 100
    if dbm <= -100:
        return 0
    return 2 * (dbm + 100)


def _parse_frequency(freq_mhz: str) -> str:
    """Return '2.4 GHz' or '5 GHz' from an MHz value string."""
    try:
        mhz = int(freq_mhz)
        return "5 GHz" if mhz > 3000 else "2.4 GHz"
    except (ValueError, TypeError):
        return freq_mhz


# ---------------------------------------------------------------------------
# Mock data
# ---------------------------------------------------------------------------


def _mock_connections() -> list[WiFiConnection]:
    return [
        WiFiConnection(
            ssid="HomeWiFi",
            uuid="a1b2c3d4-0001-0001-0001-aabbccddeeff",
            priority=100,
            auto_connect=True,
            active=True,
            device=_WIFI_INTERFACE,
            signal=85,
            ip_address="192.168.1.50",
        ),
        WiFiConnection(
            ssid="MyHotspot",
            uuid="a1b2c3d4-0002-0002-0002-aabbccddeeff",
            priority=50,
            auto_connect=True,
            active=False,
        ),
        WiFiConnection(
            ssid="HomeWiFi-Guest",
            uuid="a1b2c3d4-0003-0003-0003-aabbccddeeff",
            priority=10,
            auto_connect=True,
            active=False,
        ),
    ]


def _mock_networks() -> list[WiFiNetwork]:
    return [
        WiFiNetwork(ssid="HomeWiFi", signal=85, security="WPA2", frequency="5 GHz", in_use=True),
        WiFiNetwork(ssid="HomeWiFi-Guest", signal=78, security="WPA2", frequency="5 GHz"),
        WiFiNetwork(ssid="MyHotspot", signal=0, security="WPA2", frequency="2.4 GHz"),
        WiFiNetwork(ssid="xfinity-wifi", signal=32, security="Open", frequency="2.4 GHz"),
        WiFiNetwork(ssid="Neighbor5G", signal=25, security="WPA3", frequency="5 GHz"),
    ]


def _mock_status() -> NetworkStatus:
    return NetworkStatus(
        connected=True,
        ssid="HomeWiFi",
        signal=85,
        ip_address="192.168.1.50",
        gateway="192.168.1.1",
        dns=["192.168.1.1"],
        mac_address="dc:a6:32:aa:bb:cc",
        frequency="5 GHz",
        is_home_network=True,
    )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


class NetworkManager:
    """Manages WiFi connections via NetworkManager (nmcli)."""

    @staticmethod
    async def list_connections() -> list[WiFiConnection]:
        """List all saved WiFi connections with their priority."""
        if settings.dev_mode:
            return _mock_connections()

        result = await script_runner.run(
            "nmcli",
            ["-t", "-f", "NAME,UUID,TYPE,DEVICE,ACTIVE", "connection", "show"],
            timeout=10,
        )
        if result.returncode != 0:
            logger.error("nmcli connection show failed: %s", result.stderr)
            return []

        connections: list[WiFiConnection] = []
        for line in result.stdout.splitlines():
            parts = line.split(":")
            if len(parts) < 5:
                continue
            name, uuid, conn_type, device, active = parts[0], parts[1], parts[2], parts[3], parts[4]
            if conn_type not in ("802-11-wireless", "wifi"):
                continue

            # Fetch priority and autoconnect for each WiFi connection
            detail = await script_runner.run(
                "nmcli",
                [
                    "-t", "-f",
                    "connection.autoconnect,connection.autoconnect-priority",
                    "connection", "show", uuid,
                ],
                timeout=5,
            )
            priority = 0
            auto_connect = True
            if detail.returncode == 0:
                for dline in detail.stdout.splitlines():
                    if "autoconnect-priority" in dline:
                        try:
                            priority = int(dline.split(":")[-1])
                        except ValueError:
                            pass
                    elif "autoconnect:" in dline and "priority" not in dline:
                        auto_connect = dline.split(":")[-1].strip().lower() == "yes"

            is_active = active.lower() == "yes"
            dev = device if device and device != "--" else None

            # Populate the IP for the ACTIVE connection (otherwise the UI's IP column
            # is always blank — the WiFiConnection was constructed without it before).
            ip_address: str | None = None
            if is_active and dev:
                ipres = await script_runner.run(
                    "nmcli", ["-g", "IP4.ADDRESS", "device", "show", dev], timeout=5,
                )
                if ipres.returncode == 0 and ipres.stdout.strip():
                    # e.g. "192.168.1.5/24" (possibly multiple lines) — first, no CIDR
                    first = ipres.stdout.strip().splitlines()[0]
                    ip_address = first.split("/")[0] or None

            connections.append(
                WiFiConnection(
                    ssid=name,
                    uuid=uuid,
                    priority=priority,
                    auto_connect=auto_connect,
                    active=is_active,
                    device=dev,
                    ip_address=ip_address,
                )
            )

        # Sort by priority descending
        connections.sort(key=lambda c: c.priority, reverse=True)
        return connections

    @staticmethod
    async def list_available_networks() -> list[WiFiNetwork]:
        """Scan for available WiFi networks in range."""
        if settings.dev_mode:
            return _mock_networks()

        result = await script_runner.run(
            "nmcli",
            ["-t", "-f", "IN-USE,SSID,SIGNAL,SECURITY,FREQ", "device", "wifi", "list"],
            timeout=15,
        )
        if result.returncode != 0:
            logger.error("nmcli wifi list failed: %s", result.stderr)
            return []

        seen: set[str] = set()
        networks: list[WiFiNetwork] = []
        for line in result.stdout.splitlines():
            parts = line.split(":")
            if len(parts) < 5:
                continue
            in_use = parts[0].strip() == "*"
            ssid = parts[1].strip()
            if not ssid or ssid in seen:
                continue
            seen.add(ssid)
            try:
                signal = int(parts[2])
            except ValueError:
                signal = 0
            security = parts[3] if parts[3] else "Open"
            frequency = _parse_frequency(parts[4])
            networks.append(
                WiFiNetwork(
                    ssid=ssid,
                    signal=signal,
                    security=security,
                    frequency=frequency,
                    in_use=in_use,
                )
            )

        networks.sort(key=lambda n: n.signal, reverse=True)
        return networks

    @staticmethod
    async def add_connection(
        ssid: str,
        password: str,
        priority: int = 0,
        hidden: bool = False,
        auto_connect: bool = True,
    ) -> bool:
        """Add a new WiFi connection profile."""
        if settings.dev_mode:
            logger.info("Dev mode: pretending to add WiFi connection '%s'", ssid)
            return True

        # Create the connection
        add_args = [
            "connection", "add",
            "type", "wifi",
            "con-name", ssid,
            "ssid", ssid,
        ]
        if hidden:
            add_args += ["wifi.hidden", "yes"]

        result = await script_runner.run("nmcli", add_args, timeout=10)
        if result.returncode != 0:
            logger.error("Failed to add connection '%s': %s", ssid, result.stderr)
            return False

        # Set WPA-PSK security
        result = await script_runner.run(
            "nmcli",
            [
                "connection", "modify", ssid,
                "wifi-sec.key-mgmt", "wpa-psk",
                "wifi-sec.psk", password,
            ],
            timeout=10,
        )
        if result.returncode != 0:
            logger.error("Failed to set security for '%s': %s", ssid, result.stderr)
            # Roll back the connection we just created
            await script_runner.run("nmcli", ["connection", "delete", ssid], timeout=5)
            return False

        # Set priority and autoconnect
        result = await script_runner.run(
            "nmcli",
            [
                "connection", "modify", ssid,
                "connection.autoconnect", "yes" if auto_connect else "no",
                "connection.autoconnect-priority", str(priority),
            ],
            timeout=10,
        )
        if result.returncode != 0:
            logger.warning("Failed to set priority for '%s': %s", ssid, result.stderr)

        return True

    @staticmethod
    async def remove_connection(ssid: str) -> bool:
        """Remove a saved WiFi connection profile."""
        if settings.dev_mode:
            logger.info("Dev mode: pretending to remove WiFi connection '%s'", ssid)
            return True

        result = await script_runner.run(
            "nmcli", ["connection", "delete", ssid], timeout=10,
        )
        if result.returncode != 0:
            logger.error("Failed to remove connection '%s': %s", ssid, result.stderr)
            return False
        return True

    @staticmethod
    async def update_priority(ssid: str, priority: int) -> bool:
        """Change connection autoconnect priority (higher = preferred)."""
        if settings.dev_mode:
            logger.info("Dev mode: pretending to set priority %d for '%s'", priority, ssid)
            return True

        result = await script_runner.run(
            "nmcli",
            ["connection", "modify", ssid, "connection.autoconnect-priority", str(priority)],
            timeout=10,
        )
        if result.returncode != 0:
            logger.error("Failed to update priority for '%s': %s", ssid, result.stderr)
            return False
        return True

    @staticmethod
    async def get_active_connection() -> WiFiConnection | None:
        """Get the currently active WiFi connection, if any."""
        if settings.dev_mode:
            for conn in _mock_connections():
                if conn.active:
                    return conn
            return None

        result = await script_runner.run(
            "nmcli",
            ["-t", "-f", "NAME,DEVICE,TYPE", "connection", "show", "--active"],
            timeout=10,
        )
        if result.returncode != 0:
            return None

        for line in result.stdout.splitlines():
            parts = line.split(":")
            if len(parts) >= 3 and parts[2] in ("802-11-wireless", "wifi"):
                name, device = parts[0], parts[1]
                return WiFiConnection(
                    ssid=name,
                    uuid="",
                    priority=0,
                    auto_connect=True,
                    active=True,
                    device=device,
                )
        return None

    @staticmethod
    async def get_status() -> NetworkStatus:
        """Get overall network status: WiFi state, IP, signal, gateway."""
        if settings.dev_mode:
            return _mock_status()

        status = NetworkStatus(connected=False)

        # Current SSID
        result = await script_runner.run("iwgetid", ["-r"], timeout=5)
        if result.returncode == 0 and result.stdout:
            status.connected = True
            status.ssid = result.stdout.strip()

        # IP address and gateway
        result = await script_runner.run(
            "nmcli",
            ["-t", "-f", "IP4.ADDRESS,IP4.GATEWAY,IP4.DNS,GENERAL.HWADDR",
             "device", "show", _WIFI_INTERFACE],
            timeout=10,
        )
        if result.returncode == 0:
            for line in result.stdout.splitlines():
                if line.startswith("IP4.ADDRESS"):
                    addr = line.split(":", 1)[-1].strip()
                    # Remove CIDR prefix
                    status.ip_address = addr.split("/")[0] if addr else None
                elif line.startswith("IP4.GATEWAY"):
                    gw = line.split(":", 1)[-1].strip()
                    status.gateway = gw if gw else None
                elif line.startswith("IP4.DNS"):
                    dns = line.split(":", 1)[-1].strip()
                    if dns:
                        status.dns.append(dns)
                elif line.startswith("GENERAL.HWADDR"):
                    mac = line.split(":", 1)[-1].strip()
                    status.mac_address = mac if mac else None

        # Signal strength
        result = await script_runner.run(
            "bash",
            ["-c", f"iwconfig {_WIFI_INTERFACE} 2>/dev/null | grep -o 'Signal level=.*' | grep -o '[-0-9]*'"],
            timeout=5,
        )
        if result.returncode == 0 and result.stdout:
            try:
                dbm = int(result.stdout.splitlines()[0])
                status.signal = _dbm_to_percent(dbm)
            except ValueError:
                pass

        # Frequency
        result = await script_runner.run(
            "bash",
            ["-c", f"iwconfig {_WIFI_INTERFACE} 2>/dev/null | grep -o 'Frequency:[0-9.]*' | cut -d: -f2"],
            timeout=5,
        )
        if result.returncode == 0 and result.stdout:
            try:
                ghz = float(result.stdout.strip())
                status.frequency = "5 GHz" if ghz > 3.0 else "2.4 GHz"
            except ValueError:
                pass

        # Determine if on home network (home gateway is 192.168.x.1)
        if status.gateway and status.gateway.startswith("192.168."):
            status.is_home_network = True

        return status

    @staticmethod
    async def connect(ssid: str) -> bool:
        """Manually connect to a specific saved network."""
        if settings.dev_mode:
            logger.info("Dev mode: pretending to connect to '%s'", ssid)
            return True

        result = await script_runner.run(
            "nmcli", ["connection", "up", ssid], timeout=30,
        )
        if result.returncode != 0:
            logger.error("Failed to connect to '%s': %s", ssid, result.stderr)
            return False
        return True

    @staticmethod
    async def disconnect() -> bool:
        """Disconnect from current WiFi."""
        if settings.dev_mode:
            logger.info("Dev mode: pretending to disconnect WiFi")
            return True

        result = await script_runner.run(
            "nmcli", ["device", "disconnect", _WIFI_INTERFACE], timeout=10,
        )
        if result.returncode != 0:
            logger.error("Failed to disconnect WiFi: %s", result.stderr)
            return False
        return True

    @staticmethod
    async def scan() -> list[WiFiNetwork]:
        """Trigger a fresh WiFi scan, then return results."""
        if settings.dev_mode:
            return _mock_networks()

        # Trigger rescan (may take a few seconds)
        await script_runner.run(
            "nmcli", ["device", "wifi", "rescan"], timeout=10,
        )

        # Return the refreshed list
        return await NetworkManager.list_available_networks()
