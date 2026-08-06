"""WireGuard tunnel management for TeslaPi.

Manages the ``wg-teslapi`` interface used to tunnel back to the home
network (e.g. your home firewall) when the Pi is on a non-home
network such as a mobile hotspot.

In dev mode every method returns realistic mock data.
"""

import ipaddress
import logging
import os
import re
import shlex
import textwrap
from pathlib import Path

from backend.config import settings
from backend.models.schemas import WireGuardConfig, WireGuardStatus
from backend.services import script_runner

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Input validation — every WireGuard field is written into a config file and
# some are `source`d by a root dispatcher, so reject anything malformed (a stray
# newline could inject a wg directive; `$()`/backticks in a sourced value would
# run as root). We also NEVER build shell strings from these — see _sudo_write.
# ---------------------------------------------------------------------------

_WG_KEY_RE = re.compile(r'[A-Za-z0-9+/]{43}=')          # base64-encoded 32-byte key
_ENDPOINT_RE = re.compile(r'(?:[A-Za-z0-9.\-]+|\[[0-9A-Fa-f:]+\]):\d{1,5}')  # host:port
_IPLIST_RE = re.compile(r'[0-9A-Fa-f:.,/ ]*')           # comma/space IPv4/IPv6/CIDR list


def _valid_wg_key(v: str) -> bool:
    return bool(v) and _WG_KEY_RE.fullmatch(v) is not None


def _valid_endpoint(v: str) -> bool:
    return bool(v) and _ENDPOINT_RE.fullmatch(v) is not None


def _valid_iplist(v: str) -> bool:
    # Empty is allowed (dns is optional); otherwise only IP/CIDR-list characters.
    return _IPLIST_RE.fullmatch(v or "") is not None


async def _read_stored_private_key() -> str:
    """Read the server-stored WireGuard private key written by /generate-keys.
    It lives in the root-owned config dir, so read it via sudo. Returns '' if it
    doesn't exist yet (caller then reports "generate keys first")."""
    res = await script_runner.run("sudo", ["cat", str(WG_PRIVATE_KEY_PATH)], timeout=5)
    if res.returncode == 0 and res.stdout.strip():
        return res.stdout.strip()
    return ""


async def _read_active_config_private_key() -> str:
    """Extract the PrivateKey from the live WireGuard config, so an empty-key save
    (an edit) preserves the ACTIVE tunnel identity instead of silently swapping it
    for whatever /generate-keys last wrote. Returns '' if there's no active config."""
    res = await script_runner.run("sudo", ["cat", str(WG_CONFIG_PATH)], timeout=5)
    if res.returncode != 0:
        return ""
    for line in res.stdout.splitlines():
        stripped = line.strip()
        if stripped.lower().startswith("privatekey"):
            _, _, value = stripped.partition("=")
            return value.strip()
    return ""


async def _read_active_config_text() -> str | None:
    """Return the full current WireGuard config file text, or None if it can't be
    read. Used to snapshot a working config before overwriting it, so a failed
    reload can roll back instead of stranding the Pi with a broken tunnel."""
    res = await script_runner.run("sudo", ["cat", str(WG_CONFIG_PATH)], timeout=5)
    if res.returncode != 0:
        return None
    return res.stdout


def _has_ip_networks(value: str) -> bool:
    """True if *value* is a comma/space-separated list in which every token parses
    as a real IP network (IPv4/IPv6, with or without prefix) and there is at least
    one. Stricter than the charset allowlist ``_valid_iplist`` — it rejects a
    truncated read that severed a value mid-token (e.g. ``10.0.0``), which is exactly
    the corruption the restorability check guards against."""
    tokens = [t for t in re.split(r'[,\s]+', value.strip()) if t]
    if not tokens:
        return False
    for token in tokens:
        try:
            ipaddress.ip_network(token, strict=False)
        except ValueError:
            return False
    return True


def _snapshot_is_restorable(text: str | None) -> bool:
    """A rollback snapshot is only useful if restoring it brings back a FUNCTIONAL
    tunnel home. An interface that comes up with no address, or a peer with no
    reachable endpoint, strands the Pi just as badly as a config that won't come up
    at all — so require the full routable set: a valid [Interface] PrivateKey and
    Address, plus a [Peer] PublicKey, Endpoint, and AllowedIPs. Without AllowedIPs
    the tunnel comes up but installs no routes, so nothing reaches home. Anything
    short of the complete routable set is treated as no rollback target. (These are
    every field needed to route home; keepalive and DNS are optional.)"""
    if not text:
        return False
    has_private = has_address = has_public = has_endpoint = has_allowed = False
    for line in text.splitlines():
        key, sep, value = line.strip().partition("=")
        if not sep:
            continue
        key = key.strip().lower()
        value = value.strip()
        if key == "privatekey" and _valid_wg_key(value):
            has_private = True
        elif key == "address" and _has_ip_networks(value):
            has_address = True
        elif key == "publickey" and _valid_wg_key(value):
            has_public = True
        elif key == "endpoint" and _valid_endpoint(value):
            has_endpoint = True
        elif key == "allowedips" and _has_ip_networks(value):
            has_allowed = True
    return has_private and has_address and has_public and has_endpoint and has_allowed


async def _interface_is_active() -> bool:
    """True if the WireGuard interface is currently up (the kernel has it loaded).
    A live interface keeps its running config until reloaded, so configure() uses
    this to decide whether a written change needs to be reapplied to the tunnel."""
    res = await script_runner.run("wg", ["show", WG_INTERFACE], timeout=10)
    return res.returncode == 0


async def _sudo_write(dest: Path, content: str, mode: str) -> bool:
    """Write ``content`` to a root-owned path via ``sudo tee`` with the content on
    stdin — never through a shell — then ``sudo chmod``. Returns True on success."""
    tee = await script_runner.run("sudo", ["tee", str(dest)], input_data=content, timeout=10)
    if tee.returncode != 0:
        logger.error("Failed to write %s: %s", dest, tee.stderr)
        return False
    chmod = await script_runner.run("sudo", ["chmod", mode, str(dest)], timeout=10)
    if chmod.returncode != 0:
        logger.error("Failed to chmod %s: %s", dest, chmod.stderr)
        return False
    return True

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

        # The UI never sends the private key — it's generated and stored server-side
        # by /generate-keys (never exposed to the browser). When it's omitted, the
        # UI sets use_generated_key to signal intent:
        #   - use_generated_key=True  → the user just generated keys; apply the stored
        #     key so regeneration actually takes effect.
        #   - use_generated_key=False → an edit (e.g. change the endpoint); preserve
        #     the key already in the ACTIVE config so the tunnel identity never
        #     silently swaps. Fall back to the stored key for first-time setup, when
        #     no active config exists yet.
        private_key = config.private_key
        if not private_key and config.use_generated_key:
            private_key = await _read_stored_private_key()
        if not private_key:
            private_key = await _read_active_config_private_key()
        if not private_key:
            private_key = await _read_stored_private_key()

        # Validate required fields
        if not private_key or not config.peer_public_key or not config.peer_endpoint:
            logger.error("WireGuard config missing required fields "
                         "(no private key — generate keys first?)")
            return False

        # Validate every field before it reaches the config file.
        if not _valid_wg_key(private_key) or not _valid_wg_key(config.peer_public_key):
            logger.error("Invalid WireGuard key format")
            return False
        if not _valid_endpoint(config.peer_endpoint):
            logger.error("Invalid WireGuard endpoint")
            return False
        if not (_valid_iplist(config.address) and _valid_iplist(config.allowed_ips)
                and _valid_iplist(config.dns or "")):
            logger.error("Invalid WireGuard address/allowed_ips/dns")
            return False
        try:
            keepalive = int(config.persistent_keepalive)
        except (TypeError, ValueError):
            logger.error("Invalid persistent_keepalive")
            return False

        # Build config file content
        iface_section = f"""\
[Interface]
PrivateKey = {private_key}
Address = {config.address}"""

        if config.dns:
            iface_section += f"\nDNS = {config.dns}"

        peer_section = f"""\
[Peer]
PublicKey = {config.peer_public_key}
Endpoint = {config.peer_endpoint}
AllowedIPs = {config.allowed_ips}
PersistentKeepalive = {keepalive}"""

        conf_content = f"{iface_section}\n\n{peer_section}\n"

        # Ensure directory exists and write config
        try:
            WG_CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            logger.error("Cannot create wireguard config dir: %s", exc)
            return False

        # If the tunnel is up, snapshot its working config BEFORE overwriting it so
        # a bad new config can be rolled back — this Pi may be reachable only via
        # this tunnel, so a failed reload must not strand it with a down interface.
        was_active = await _interface_is_active()
        previous_config = await _read_active_config_text() if was_active else None

        # Refuse to overwrite a LIVE tunnel's config unless we captured a RESTORABLE
        # rollback snapshot — missing, empty, or truncated (no PrivateKey/PublicKey)
        # is no rollback target at all, and a bad new config would then strand the Pi
        # with no way back. Leave the working tunnel untouched and report failure.
        if was_active and not _snapshot_is_restorable(previous_config):
            logger.error("Refusing to update the active WireGuard config: could not "
                         "read a restorable current config to enable rollback")
            return False

        # Write via sudo tee with content on stdin (never a shell string).
        if not await _sudo_write(WG_CONFIG_PATH, conf_content, "600"):
            return False

        logger.info("WireGuard config written to %s", WG_CONFIG_PATH)

        # A running interface keeps its old config (key, endpoint, peer) until it's
        # reloaded — so writing the file alone would leave a regenerated key or a
        # changed endpoint inert on the live tunnel. If it's up, bounce it so the
        # new config actually takes effect, and roll back on any failure.
        if was_active:
            logger.info("Reloading active WireGuard interface to apply new config")
            if not await WireGuardManager.disable():
                # Still up on the OLD config in the kernel — make the file match
                # what's running so on-disk state is consistent, then fail.
                logger.error("Failed to bring %s down to apply new config", WG_INTERFACE)
                if previous_config is not None:
                    await _sudo_write(WG_CONFIG_PATH, previous_config, "600")
                return False
            if not await WireGuardManager.enable():
                # New config wouldn't come up and the interface is now DOWN. Restore
                # the last-known-good config and bring THAT back up.
                logger.error("New WireGuard config failed to activate; rolling back")
                if previous_config is not None and await _sudo_write(
                    WG_CONFIG_PATH, previous_config, "600"
                ):
                    if await WireGuardManager.enable():
                        logger.info("Rolled back to the previous WireGuard config")
                    else:
                        logger.error("Rollback config failed to activate — tunnel is down")
                else:
                    logger.error("No previous config to roll back to — tunnel is down")
                return False
            logger.info("WireGuard interface %s reloaded with new config", WG_INTERFACE)

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

        # Validate the SSID: reject control characters and cap the length. The value
        # is written shlex-quoted because the dispatcher `source`s this file — an
        # unquoted `$(...)`/backtick in an SSID would otherwise run as root.
        if any(ord(c) < 0x20 or ord(c) == 0x7f for c in home_ssid) or len(home_ssid.encode("utf-8")) > 64:
            logger.error("Invalid home_ssid")
            return False

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
            HOME_SSID={shlex.quote(home_ssid)}
        """)

        if not await _sudo_write(AUTO_CONFIG_PATH, config_content, "644"):
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

            # Dispatcher content is static (only our own constants), but write it via
            # stdin too for consistency and to drop the `echo '...'` shell pattern.
            if not await _sudo_write(DISPATCHER_SCRIPT, dispatcher_content, "755"):
                logger.error("Failed to install dispatcher script")
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
