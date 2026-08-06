"""Unit tests for the security-critical pure functions fixed during the loop:
config shell-quoting/injection (iter 3/5), WireGuard field validators (iter 4),
and the notification env-name allowlist (iter 4b). Fast, no app/DB needed.
"""

import os
import subprocess

import pytest

import backend.services.config_manager as cm
import backend.services.wireguard_manager as wg
from backend.services.notification_service import _ALLOWED_PUSH_ENV_PREFIXES, _ENV_NAME_RE


# --- config_manager: shell-quoting round-trip + injection neutralization ---

@pytest.mark.parametrize("value", [
    "plain", "has space", "it's", "Bob's WiFi", 'q"uote',
    "back`tick`", "dollar$(id)", "semi;colon", "", "p@ss w0rd!",
])
def test_quote_unquote_roundtrip(value):
    assert cm._unquote(cm._quote(value)) == value


def test_quote_is_inert_when_sourced_by_bash():
    for marker in ("/tmp/PWN_units", "/tmp/PWN2_units"):
        if os.path.exists(marker):
            os.remove(marker)
    payload = "x`touch /tmp/PWN_units`$(touch /tmp/PWN2_units)y"
    q = cm._quote(payload)
    r = subprocess.run(["bash", "-c", f"VAR={q}\nprintf '%s' \"$VAR\""],
                       capture_output=True, text=True)
    assert not os.path.exists("/tmp/PWN_units"), "backtick executed!"
    assert not os.path.exists("/tmp/PWN2_units"), "$() executed!"
    assert r.stdout == payload  # sourced literally


def test_config_write_drops_masked_secret_and_validates(tmp_path, monkeypatch):
    conf = tmp_path / "c.conf"
    conf.write_text('WIFIPASS="realsecret"\nSSID="Home"\n')
    monkeypatch.setattr(cm.settings, "teslausb_config_path", str(conf))

    # Masked SENSITIVE value must be dropped (keep existing); non-secret writes.
    cm.write_config({"WIFIPASS": "********", "SSID": "NewName"})
    raw = cm.read_config()
    assert raw["WIFIPASS"] == "realsecret"
    assert raw["SSID"] == "NewName"

    # A non-secret key literally "********" still writes (scoped drop).
    cm.write_config({"SSID": "********"})
    assert cm.read_config()["SSID"] == "********"

    with pytest.raises(ValueError):
        cm.write_config({"BAD KEY;": "x"})       # non-identifier key
    with pytest.raises(ValueError):
        cm.write_config({"OK": "a\nb"})          # control char in value


# --- WireGuard field validators ---

def test_wg_key_validator():
    assert wg._valid_wg_key("A" * 43 + "=")
    assert not wg._valid_wg_key("abc'; reboot; '")
    assert not wg._valid_wg_key("")


def test_wg_endpoint_validator():
    assert wg._valid_endpoint("vpn.home.net:51820")
    assert wg._valid_endpoint("[2001:db8::1]:51820")
    assert not wg._valid_endpoint("host:51820\nPublicKey = x")  # newline injection
    assert not wg._valid_endpoint("")


def test_wg_iplist_validator():
    assert wg._valid_iplist("0.0.0.0/0, ::/0")
    assert wg._valid_iplist("")  # dns is optional
    assert not wg._valid_iplist("0.0.0.0/0\nEvil = 1")  # newline injection


# --- notification env allowlist: exercise the REAL _send_push boundary ---

async def test_send_push_forwards_only_allowlisted_env(monkeypatch):
    """Drive the actual _send_push code: attacker-controllable config keys become
    env var NAMES, so BASH_ENV/LD_PRELOAD/PATH/IFS must never reach the subprocess
    while genuine service vars do. Spies on the real script_runner.run call."""
    import backend.services.notification_service as ns

    captured = {}

    async def fake_run(script, args=None, timeout=30, cwd=None, env=None, input_data=None):
        captured["script"] = script
        captured["args"] = args
        captured["env"] = env or {}

        class _R:
            returncode = 0
            stderr = ""

        return _R()

    monkeypatch.setattr(ns.script_runner, "run", fake_run)

    config = {
        "type": "telegram",
        "telegram_bot_token": "123:abc",
        "telegram_chat_id": "42",
        # attacker attempts to set shell/loader-sensitive vars via config keys:
        "bash_env": "/tmp/evil.sh",
        "ld_preload": "/tmp/evil.so",
        "path": "/tmp/evil",
        "ifs": " ",
    }
    await ns.NotificationService()._send_push(config, "Title", "Message")

    env = captured["env"]
    # title/message are argv (not shell-interpolated), config is env
    assert captured["script"] == "bash"
    assert captured["args"] == ["run/send-push-message", "Title", "Message"]
    assert env.get("TELEGRAM_BOT_TOKEN") == "123:abc"
    assert env.get("TELEGRAM_CHAT_ID") == "42"
    for danger in ("BASH_ENV", "LD_PRELOAD", "PATH", "IFS"):
        assert danger not in env, f"dangerous env var forwarded: {danger}"


def test_allowlist_constants_present():
    # Guard against the prefixes/regex being removed or emptied.
    assert "TELEGRAM_" in _ALLOWED_PUSH_ENV_PREFIXES
    assert _ENV_NAME_RE.fullmatch("TELEGRAM_BOT_TOKEN")
    assert not _ENV_NAME_RE.fullmatch("bad key")


def test_is_sensitive_key_matches_secrets_not_false_positives():
    # Security (config masking): a MISS leaks a real secret; the regex was tuned to
    # match teslausb's actual secret keys while avoiding the bare-`pass` false positive.
    from backend.services import config_manager as cm

    # Must be treated as sensitive (masked on GET, mask-preserved on write):
    for k in [
        "WIFIPASS", "WIFI_PASS", "SHARE_PASSWORD", "MQTT_PASSWORD",
        "HA_TOKEN", "SECRET_KEY_BASE", "API_KEY", "wifipass",  # case-insensitive
    ]:
        assert cm.is_sensitive_key(k) is True, k

    # Must NOT be masked (would be a nuisance, but also confirms no bare-`pass` match):
    for k in ["SSID", "ARCHIVE_SERVER", "COMPASS", "HOSTNAME", "MUSIC_SERVER", "ENABLED"]:
        assert cm.is_sensitive_key(k) is False, k
