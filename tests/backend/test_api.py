"""API-level regression tests for fixes made during the hardening loop.

Each test names the iteration/finding it guards so a regression is obvious.
Runs against the real app in dev mode (see conftest).
"""


def _write_conf(path, text):
    with open(path, "w") as f:
        f.write(text)


def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_auto_check_get_exists(client):
    # iter 7 (M-F5): GET was missing → 405 on load. Now returns the config.
    r = client.get("/api/updates/auto-check")
    assert r.status_code == 200
    body = r.json()
    for key in ("enabled", "interval_hours", "last_check", "update_available", "latest_version"):
        assert key in body


def test_update_check_is_self_describing(client):
    # iter 7f: explicit status so consumers never claim a false "up to date".
    r = client.get("/api/updates/check")
    assert r.status_code == 200
    assert r.json().get("status") in ("update_available", "up_to_date", "no_releases", "error")


def test_ha_test_does_not_exfiltrate_saved_token(client, monkeypatch):
    # iter 8d (security): with a REAL saved token, a masked-token + attacker-url
    # request must be refused AND must never construct an HA client carrying the
    # saved token toward the attacker url. Spy on the client to prove it.
    saved_url, saved_token = "http://ha.local:8123", "SECRET-JWT-abc123"
    r = client.put("/api/ha/config", json={"url": saved_url, "token": saved_token, "enabled": False})
    assert r.status_code == 200

    from backend.services import ha_client
    seen: list[tuple[str, str]] = []

    class SpyClient:
        def __init__(self, url, token):
            seen.append((url, token))

        async def test_connection(self):
            return {"version": "test", "message": "ok"}

    monkeypatch.setattr(ha_client, "HAClient", SpyClient)

    # Attacker: masked token + their own url.
    r = client.post("/api/ha/test", json={"url": "http://attacker.example", "token": "********"})
    assert r.json()["ok"] is False
    # The saved token must NOT have been sent anywhere, and no client aimed at the
    # attacker url — either would mean exfiltration.
    assert all(tok != saved_token for _, tok in seen), f"saved token leaked: {seen}"
    assert all(url != "http://attacker.example" for url, _ in seen), f"client aimed at attacker: {seen}"

    # Positive path: retest saved creds (masked token + SAME url) DOES reuse the saved
    # token — against the saved url only.
    seen.clear()
    r = client.post("/api/ha/test", json={"url": saved_url, "token": "********"})
    assert r.json()["ok"] is True
    assert seen == [(saved_url, saved_token)]


def test_ha_test_empty_saved_url_no_exfiltration(client, monkeypatch):
    # iter 8d CRITICAL case: a saved token with an EMPTY saved url. The earlier guard
    # (`url and cfg.url and ...`) required a truthy saved url, so an attacker url +
    # masked token slipped past and got the saved token. Must be refused with no leak.
    saved_token = "SECRET-JWT-empty-url"
    r = client.put("/api/ha/config", json={"url": "", "token": saved_token, "enabled": False})
    assert r.status_code == 200

    from backend.services import ha_client
    seen: list[tuple[str, str]] = []

    class SpyClient:
        def __init__(self, url, token):
            seen.append((url, token))

        async def test_connection(self):
            return {"version": "t", "message": "ok"}

    monkeypatch.setattr(ha_client, "HAClient", SpyClient)

    r = client.post("/api/ha/test", json={"url": "http://attacker.example", "token": "********"})
    assert r.json()["ok"] is False
    # No client should have been constructed at all; certainly not with the saved token.
    assert all(tok != saved_token for _, tok in seen), f"saved token leaked: {seen}"
    assert all(url != "http://attacker.example" for url, _ in seen), f"client aimed at attacker: {seen}"


def test_ha_test_requires_credentials(client):
    # No url/token and no saved config → honest failure, never a crash.
    r = client.post("/api/ha/test", json={})
    assert r.status_code == 200
    assert r.json()["ok"] is False


def test_notifications_adhoc_test_route_exists(client):
    # iter 8: ad-hoc test endpoint (coexists with /test/{channel_id}).
    r = client.post("/api/notifications/test", json={"type": "telegram", "config": {}})
    assert r.status_code == 200
    assert "ok" in r.json()


def test_config_masks_secrets(client, conf_path):
    # iter 5b/5c: WIFIPASS (teslausb's key) must mask; non-secret passes through.
    _write_conf(conf_path, 'ARCHIVE_SERVER="nas.local"\nWIFIPASS="s3cret"\nSHARE_PASSWORD="pw"\n')
    cfg = client.get("/api/config").json()["config"]
    assert cfg.get("WIFIPASS") == "********"
    assert cfg.get("SHARE_PASSWORD") == "********"
    assert cfg.get("ARCHIVE_SERVER") == "nas.local"


def test_config_write_drops_masked_secret(client, conf_path):
    # iter 5b: echoing the mask back must NOT overwrite the real stored secret.
    _write_conf(conf_path, 'WIFIPASS="realsecret"\nSSID="Home"\n')
    r = client.put("/api/config", json={"updates": {"WIFIPASS": "********", "SSID": "NewName"}})
    assert r.status_code == 200
    from backend.services import config_manager
    raw = config_manager.read_config()
    assert raw["WIFIPASS"] == "realsecret"  # preserved, not clobbered by the mask
    assert raw["SSID"] == "NewName"


def test_config_write_rejects_bad_key(client, conf_path):
    # iter 5: keys must be bash identifiers (no injection via key).
    _write_conf(conf_path, 'SSID="Home"\n')
    r = client.put("/api/config", json={"updates": {"BAD KEY;": "x"}})
    assert r.status_code == 500  # ValueError -> 500 (write refused)


def test_ota_upload_disabled_by_default(client):
    # iter 5b (security): unsigned OTA upload runs code as root, so it must be
    # refused unless explicitly enabled (allow_unsigned_updates defaults False).
    r = client.post(
        "/api/updates/upload",
        files={"file": ("x.tar.gz", b"payload", "application/gzip")},
    )
    assert r.status_code == 403


def test_ota_upload_allowed_when_opted_in(client, monkeypatch, tmp_path):
    # With the opt-in flag on, the request passes the gate and reaches the apply
    # step. Isolate UPDATE_DIR to a per-test path (so nothing writes to the real
    # /tmp/teslapi-update), spy on apply (don't run the real/simulated update), and
    # confirm the dest filename was basename-sanitized and written into the temp dir.
    import os
    from backend.config import settings
    from backend.services.updater import updater
    upd_dir = str(tmp_path / "upd")
    monkeypatch.setattr(settings, "allow_unsigned_updates", True)
    monkeypatch.setattr(updater, "UPDATE_DIR", upd_dir)

    called = {}

    async def fake_apply(path):
        called["path"] = path
        return {"success": True}

    monkeypatch.setattr(updater, "apply_uploaded_update", fake_apply)
    r = client.post(
        "/api/updates/upload",
        files={"file": ("../../evil.tar.gz", b"data", "application/gzip")},
    )
    assert r.status_code == 200
    assert os.path.basename(called["path"]) == "evil.tar.gz"  # traversal stripped
    assert called["path"].startswith(upd_dir)  # written into the isolated dir, not real state
    assert "/../" not in called["path"]


def test_wifi_add_threads_auto_connect(client, monkeypatch):
    # M-F2: unchecking auto-connect must reach the backend (frontend now sends
    # snake_case auto_connect; the endpoint passes it to NetworkManager).
    from backend.routers import network as net

    captured = {}

    async def fake_add(ssid, password, priority=0, hidden=False, auto_connect=True):
        captured["ssid"] = ssid
        captured["auto_connect"] = auto_connect
        return True

    monkeypatch.setattr(net.NetworkManager, "add_connection", fake_add)
    r = client.post(
        "/api/network/wifi/add",
        json={"ssid": "Home", "password": "pw123456", "auto_connect": False},
    )
    assert r.status_code == 200
    assert captured["ssid"] == "Home"
    assert captured["auto_connect"] is False  # not silently defaulted to True


# A structurally complete WireGuard config usable as a rollback snapshot: it carries
# both a valid [Interface] PrivateKey and a valid [Peer] PublicKey.
_RESTORABLE_WG_CONFIG = (
    "[Interface]\n"
    "PrivateKey = " + "O" + "l" * 42 + "=\n"
    "Address = 10.13.13.9/32\n"
    "\n"
    "[Peer]\n"
    "PublicKey = " + "P" + "k" * 42 + "=\n"
    "Endpoint = old.endpoint.net:51820\n"
    "AllowedIPs = 0.0.0.0/0\n"
)


def test_wireguard_save_accepts_snake_case(client, monkeypatch):
    # C9: the frontend now sends snake_case; the endpoint must accept it and thread
    # it to configure() (camelCase used to 422 every save).
    from backend.routers import network as net

    captured = {}

    async def fake_configure(config):
        captured["config"] = config
        return True

    monkeypatch.setattr(net.WireGuardManager, "configure", fake_configure)
    body = {
        "private_key": "A" * 43 + "=",
        "address": "10.13.13.2/32",
        "peer_public_key": "B" * 43 + "=",
        "peer_endpoint": "vpn.home.net:51820",
        "allowed_ips": "0.0.0.0/0, ::/0",
        "persistent_keepalive": 25,
    }
    r = client.put("/api/network/wireguard/config", json=body)
    assert r.status_code == 200
    assert captured["config"].private_key == body["private_key"]
    assert captured["config"].peer_endpoint == "vpn.home.net:51820"


async def test_wireguard_configure_uses_stored_private_key(monkeypatch, tmp_path):
    # Gate 15b: the UI submits an EMPTY private key (it's generated + stored
    # server-side), so configure() must fall back to the stored key and still write
    # a valid [Interface] — otherwise every real save fails at the key validator.
    from backend.config import settings
    from backend.models.schemas import WireGuardConfig
    from backend.services import wireguard_manager as wgm

    monkeypatch.setattr(settings, "dev_mode", False)
    monkeypatch.setattr(wgm, "WG_CONFIG_DIR", tmp_path)  # mkdir target writable in test
    stored = "S" + "t" * 42 + "="  # valid 44-char WG key

    async def fake_active():
        return ""  # no active config yet (first-time setup)

    async def fake_read():
        return stored

    written = {}

    async def fake_write(dest, content, mode):
        written["content"] = content
        return True

    async def fake_inactive():
        return False  # tunnel not up, so no reload

    monkeypatch.setattr(wgm, "_read_active_config_private_key", fake_active)
    monkeypatch.setattr(wgm, "_read_stored_private_key", fake_read)
    monkeypatch.setattr(wgm, "_sudo_write", fake_write)
    monkeypatch.setattr(wgm, "_interface_is_active", fake_inactive)

    cfg = WireGuardConfig(
        private_key="",  # UI sends empty on purpose
        address="10.13.13.2/32",
        peer_public_key="P" + "u" * 42 + "=",
        peer_endpoint="vpn.home.net:51820",
        allowed_ips="0.0.0.0/0",
        persistent_keepalive=25,
        use_generated_key=True,  # user generated keys in the setup flow
    )
    ok = await wgm.WireGuardManager.configure(cfg)
    assert ok is True
    assert f"PrivateKey = {stored}" in written["content"]


async def test_wireguard_regenerate_applies_stored_key(monkeypatch, tmp_path):
    # Gate 15d: deliberate key regeneration must actually take effect. When the user
    # generates a new keypair and saves, use_generated_key=True forces the stored
    # (freshly generated) key even though a DIFFERENT key is live in the active config.
    from backend.config import settings
    from backend.models.schemas import WireGuardConfig
    from backend.services import wireguard_manager as wgm

    monkeypatch.setattr(settings, "dev_mode", False)
    monkeypatch.setattr(wgm, "WG_CONFIG_DIR", tmp_path)
    active = "A" + "c" * 42 + "="        # old key in the live config
    regenerated = "R" + "g" * 42 + "="   # the newly generated stored key

    async def fake_active():
        return active

    async def fake_stored():
        return regenerated

    written = {}

    async def fake_write(dest, content, mode):
        written["content"] = content
        return True

    async def fake_inactive():
        return False

    monkeypatch.setattr(wgm, "_read_active_config_private_key", fake_active)
    monkeypatch.setattr(wgm, "_read_stored_private_key", fake_stored)
    monkeypatch.setattr(wgm, "_sudo_write", fake_write)
    monkeypatch.setattr(wgm, "_interface_is_active", fake_inactive)

    cfg = WireGuardConfig(
        private_key="",
        address="10.13.13.2/32",
        peer_public_key="P" + "u" * 42 + "=",
        peer_endpoint="vpn.home.net:51820",
        allowed_ips="0.0.0.0/0",
        use_generated_key=True,  # regeneration intent
    )
    ok = await wgm.WireGuardManager.configure(cfg)
    assert ok is True
    assert f"PrivateKey = {regenerated}" in written["content"]  # new key applied
    assert active not in written["content"]                     # old key discarded


async def test_wireguard_configure_reloads_active_interface(monkeypatch, tmp_path):
    # Gate: writing the config file alone leaves a running tunnel on its OLD key/
    # endpoint. When the interface is up, configure() must bounce it so the new
    # config actually takes effect.
    from backend.config import settings
    from backend.models.schemas import WireGuardConfig
    from backend.services import wireguard_manager as wgm

    monkeypatch.setattr(settings, "dev_mode", False)
    monkeypatch.setattr(wgm, "WG_CONFIG_DIR", tmp_path)

    async def fake_active_key():
        return "A" + "c" * 42 + "="

    async def fake_stored():
        return "S" + "t" * 42 + "="

    async def fake_write(dest, content, mode):
        return True

    async def fake_is_active():
        return True  # tunnel is currently up

    async def fake_prev_text():
        return _RESTORABLE_WG_CONFIG

    calls = []

    async def fake_disable():
        calls.append("disable")
        return True

    async def fake_enable():
        calls.append("enable")
        return True

    monkeypatch.setattr(wgm, "_read_active_config_private_key", fake_active_key)
    monkeypatch.setattr(wgm, "_read_stored_private_key", fake_stored)
    monkeypatch.setattr(wgm, "_read_active_config_text", fake_prev_text)
    monkeypatch.setattr(wgm, "_sudo_write", fake_write)
    monkeypatch.setattr(wgm, "_interface_is_active", fake_is_active)
    monkeypatch.setattr(wgm.WireGuardManager, "disable", fake_disable)
    monkeypatch.setattr(wgm.WireGuardManager, "enable", fake_enable)

    cfg = WireGuardConfig(
        private_key="",
        address="10.13.13.2/32",
        peer_public_key="P" + "u" * 42 + "=",
        peer_endpoint="vpn.home.net:51820",
        allowed_ips="0.0.0.0/0",
        use_generated_key=True,
    )
    ok = await wgm.WireGuardManager.configure(cfg)
    assert ok is True
    assert calls == ["disable", "enable"]  # interface reloaded, in order


async def test_wireguard_configure_reload_failure_reports_error(monkeypatch, tmp_path):
    # If the interface is up but fails to come back up after the config change,
    # configure() must return False so the UI surfaces the broken tunnel rather
    # than reporting a successful save.
    from backend.config import settings
    from backend.models.schemas import WireGuardConfig
    from backend.services import wireguard_manager as wgm

    monkeypatch.setattr(settings, "dev_mode", False)
    monkeypatch.setattr(wgm, "WG_CONFIG_DIR", tmp_path)

    async def fake_stored():
        return "S" + "t" * 42 + "="

    async def fake_write(dest, content, mode):
        return True

    async def fake_is_active():
        return True

    async def fake_prev_text():
        return _RESTORABLE_WG_CONFIG

    async def fake_disable():
        return True

    async def fake_enable():
        return False  # neither the new config nor the rollback comes up

    monkeypatch.setattr(wgm, "_read_active_config_private_key", fake_stored)
    monkeypatch.setattr(wgm, "_read_stored_private_key", fake_stored)
    monkeypatch.setattr(wgm, "_read_active_config_text", fake_prev_text)
    monkeypatch.setattr(wgm, "_sudo_write", fake_write)
    monkeypatch.setattr(wgm, "_interface_is_active", fake_is_active)
    monkeypatch.setattr(wgm.WireGuardManager, "disable", fake_disable)
    monkeypatch.setattr(wgm.WireGuardManager, "enable", fake_enable)

    cfg = WireGuardConfig(
        private_key="",
        address="10.13.13.2/32",
        peer_public_key="P" + "u" * 42 + "=",
        peer_endpoint="vpn.home.net:51820",
        allowed_ips="0.0.0.0/0",
        use_generated_key=True,
    )
    ok = await wgm.WireGuardManager.configure(cfg)
    assert ok is False


async def test_wireguard_reload_failure_rolls_back(monkeypatch, tmp_path):
    # Gate: a failed reload of an active tunnel must roll back to the last-known-good
    # config and bring THAT up, not strand a headless Pi with a down interface and a
    # broken config on disk.
    from backend.config import settings
    from backend.models.schemas import WireGuardConfig
    from backend.services import wireguard_manager as wgm

    monkeypatch.setattr(settings, "dev_mode", False)
    monkeypatch.setattr(wgm, "WG_CONFIG_DIR", tmp_path)
    previous = _RESTORABLE_WG_CONFIG

    async def fake_stored():
        return "S" + "t" * 42 + "="

    async def fake_prev_text():
        return previous

    async def fake_is_active():
        return True

    writes = []

    async def fake_write(dest, content, mode):
        writes.append(content)
        return True

    enable_calls = []

    async def fake_disable():
        return True

    async def fake_enable():
        # First enable = the new (bad) config → fail. Second = the rollback → succeed.
        enable_calls.append(1)
        return len(enable_calls) >= 2

    monkeypatch.setattr(wgm, "_read_active_config_private_key", fake_stored)
    monkeypatch.setattr(wgm, "_read_stored_private_key", fake_stored)
    monkeypatch.setattr(wgm, "_read_active_config_text", fake_prev_text)
    monkeypatch.setattr(wgm, "_sudo_write", fake_write)
    monkeypatch.setattr(wgm, "_interface_is_active", fake_is_active)
    monkeypatch.setattr(wgm.WireGuardManager, "disable", fake_disable)
    monkeypatch.setattr(wgm.WireGuardManager, "enable", fake_enable)

    cfg = WireGuardConfig(
        private_key="",
        address="10.13.13.2/32",
        peer_public_key="P" + "u" * 42 + "=",
        peer_endpoint="vpn.home.net:51820",
        allowed_ips="0.0.0.0/0",
        use_generated_key=True,
    )
    ok = await wgm.WireGuardManager.configure(cfg)
    assert ok is False                 # save is reported as failed
    assert previous in writes          # last-known-good config restored to disk
    assert len(enable_calls) == 2      # tried new config, then rolled back up


async def test_wireguard_active_update_refused_without_snapshot(monkeypatch, tmp_path):
    # Gate: if the tunnel is UP but its current config can't be read, there's no
    # rollback safety net — configure() must leave the working tunnel untouched
    # (never overwrite the file, never bounce the interface).
    from backend.config import settings
    from backend.models.schemas import WireGuardConfig
    from backend.services import wireguard_manager as wgm

    monkeypatch.setattr(settings, "dev_mode", False)
    monkeypatch.setattr(wgm, "WG_CONFIG_DIR", tmp_path)

    async def fake_stored():
        return "S" + "t" * 42 + "="

    async def fake_is_active():
        return True

    async def fake_no_snapshot():
        return None  # current config unreadable → no rollback possible

    writes = []

    async def fake_write(dest, content, mode):
        writes.append(content)
        return True

    touched = []

    async def fake_disable():
        touched.append("disable")
        return True

    async def fake_enable():
        touched.append("enable")
        return True

    monkeypatch.setattr(wgm, "_read_active_config_private_key", fake_stored)
    monkeypatch.setattr(wgm, "_read_stored_private_key", fake_stored)
    monkeypatch.setattr(wgm, "_read_active_config_text", fake_no_snapshot)
    monkeypatch.setattr(wgm, "_sudo_write", fake_write)
    monkeypatch.setattr(wgm, "_interface_is_active", fake_is_active)
    monkeypatch.setattr(wgm.WireGuardManager, "disable", fake_disable)
    monkeypatch.setattr(wgm.WireGuardManager, "enable", fake_enable)

    cfg = WireGuardConfig(
        private_key="",
        address="10.13.13.2/32",
        peer_public_key="P" + "u" * 42 + "=",
        peer_endpoint="vpn.home.net:51820",
        allowed_ips="0.0.0.0/0",
        use_generated_key=True,
    )
    ok = await wgm.WireGuardManager.configure(cfg)
    assert ok is False       # refused
    assert writes == []      # config file never overwritten
    assert touched == []     # interface never bounced


async def test_wireguard_active_update_refused_with_truncated_snapshot(monkeypatch, tmp_path):
    # Gate: a nonempty but TRUNCATED snapshot (has [Interface] but no valid
    # PrivateKey and no [Peer] PublicKey) can't bring the tunnel back — wg-quick up
    # would fail — so it must be refused just like an empty one.
    from backend.config import settings
    from backend.models.schemas import WireGuardConfig
    from backend.services import wireguard_manager as wgm

    monkeypatch.setattr(settings, "dev_mode", False)
    monkeypatch.setattr(wgm, "WG_CONFIG_DIR", tmp_path)

    async def fake_stored():
        return "S" + "t" * 42 + "="

    async def fake_is_active():
        return True

    async def fake_truncated():
        # Non-empty and passes a naive .strip() check, but not a restorable config.
        return "[Interface]\nAddress = 10.13.13.9/32\n# PrivateKey line lost\n"

    writes = []

    async def fake_write(dest, content, mode):
        writes.append(content)
        return True

    touched = []

    async def fake_disable():
        touched.append("disable")
        return True

    async def fake_enable():
        touched.append("enable")
        return True

    monkeypatch.setattr(wgm, "_read_active_config_private_key", fake_stored)
    monkeypatch.setattr(wgm, "_read_stored_private_key", fake_stored)
    monkeypatch.setattr(wgm, "_read_active_config_text", fake_truncated)
    monkeypatch.setattr(wgm, "_sudo_write", fake_write)
    monkeypatch.setattr(wgm, "_interface_is_active", fake_is_active)
    monkeypatch.setattr(wgm.WireGuardManager, "disable", fake_disable)
    monkeypatch.setattr(wgm.WireGuardManager, "enable", fake_enable)

    cfg = WireGuardConfig(
        private_key="",
        address="10.13.13.2/32",
        peer_public_key="P" + "u" * 42 + "=",
        peer_endpoint="vpn.home.net:51820",
        allowed_ips="0.0.0.0/0",
        use_generated_key=True,
    )
    ok = await wgm.WireGuardManager.configure(cfg)
    assert ok is False       # refused
    assert writes == []      # config file never overwritten
    assert touched == []     # interface never bounced


async def test_wireguard_active_update_refused_when_snapshot_not_routable(monkeypatch, tmp_path):
    # Gate: a snapshot can carry both valid keys yet still be unusable — if it has no
    # peer Endpoint (or no interface Address), restoring it brings up a tunnel that
    # can't reach home, which strands the Pi. Such a snapshot must be refused too.
    from backend.config import settings
    from backend.models.schemas import WireGuardConfig
    from backend.services import wireguard_manager as wgm

    monkeypatch.setattr(settings, "dev_mode", False)
    monkeypatch.setattr(wgm, "WG_CONFIG_DIR", tmp_path)

    # Valid PrivateKey + Address + PublicKey, but NO Endpoint → not routable home.
    not_routable = (
        "[Interface]\n"
        "PrivateKey = " + "O" + "l" * 42 + "=\n"
        "Address = 10.13.13.9/32\n"
        "\n"
        "[Peer]\n"
        "PublicKey = " + "P" + "k" * 42 + "=\n"
        "AllowedIPs = 0.0.0.0/0\n"
    )

    async def fake_stored():
        return "S" + "t" * 42 + "="

    async def fake_is_active():
        return True

    async def fake_snapshot():
        return not_routable

    writes = []

    async def fake_write(dest, content, mode):
        writes.append(content)
        return True

    touched = []

    async def fake_disable():
        touched.append("disable")
        return True

    async def fake_enable():
        touched.append("enable")
        return True

    monkeypatch.setattr(wgm, "_read_active_config_private_key", fake_stored)
    monkeypatch.setattr(wgm, "_read_stored_private_key", fake_stored)
    monkeypatch.setattr(wgm, "_read_active_config_text", fake_snapshot)
    monkeypatch.setattr(wgm, "_sudo_write", fake_write)
    monkeypatch.setattr(wgm, "_interface_is_active", fake_is_active)
    monkeypatch.setattr(wgm.WireGuardManager, "disable", fake_disable)
    monkeypatch.setattr(wgm.WireGuardManager, "enable", fake_enable)

    cfg = WireGuardConfig(
        private_key="",
        address="10.13.13.2/32",
        peer_public_key="P" + "u" * 42 + "=",
        peer_endpoint="vpn.home.net:51820",
        allowed_ips="0.0.0.0/0",
        use_generated_key=True,
    )
    ok = await wgm.WireGuardManager.configure(cfg)
    assert ok is False       # refused
    assert writes == []      # config file never overwritten
    assert touched == []     # interface never bounced


async def test_wireguard_active_update_refused_without_allowed_ips(monkeypatch, tmp_path):
    # Gate: a snapshot with keys, Address, and Endpoint but NO AllowedIPs brings the
    # tunnel up yet installs no routes — nothing reaches home. Must be refused.
    from backend.config import settings
    from backend.models.schemas import WireGuardConfig
    from backend.services import wireguard_manager as wgm

    monkeypatch.setattr(settings, "dev_mode", False)
    monkeypatch.setattr(wgm, "WG_CONFIG_DIR", tmp_path)

    no_routes = (
        "[Interface]\n"
        "PrivateKey = " + "O" + "l" * 42 + "=\n"
        "Address = 10.13.13.9/32\n"
        "\n"
        "[Peer]\n"
        "PublicKey = " + "P" + "k" * 42 + "=\n"
        "Endpoint = old.endpoint.net:51820\n"
    )

    async def fake_stored():
        return "S" + "t" * 42 + "="

    async def fake_is_active():
        return True

    async def fake_snapshot():
        return no_routes

    writes = []

    async def fake_write(dest, content, mode):
        writes.append(content)
        return True

    touched = []

    async def fake_disable():
        touched.append("disable")
        return True

    async def fake_enable():
        touched.append("enable")
        return True

    monkeypatch.setattr(wgm, "_read_active_config_private_key", fake_stored)
    monkeypatch.setattr(wgm, "_read_stored_private_key", fake_stored)
    monkeypatch.setattr(wgm, "_read_active_config_text", fake_snapshot)
    monkeypatch.setattr(wgm, "_sudo_write", fake_write)
    monkeypatch.setattr(wgm, "_interface_is_active", fake_is_active)
    monkeypatch.setattr(wgm.WireGuardManager, "disable", fake_disable)
    monkeypatch.setattr(wgm.WireGuardManager, "enable", fake_enable)

    cfg = WireGuardConfig(
        private_key="",
        address="10.13.13.2/32",
        peer_public_key="P" + "u" * 42 + "=",
        peer_endpoint="vpn.home.net:51820",
        allowed_ips="0.0.0.0/0",
        use_generated_key=True,
    )
    ok = await wgm.WireGuardManager.configure(cfg)
    assert ok is False
    assert writes == []
    assert touched == []


async def test_wireguard_active_update_refused_with_truncated_ip_value(monkeypatch, tmp_path):
    # Gate: a truncated read can sever an IP value mid-token (e.g. "10.0.0"), which
    # passes the loose charset allowlist but is not a real network. The restorability
    # check must parse the value, not just its character set, and refuse this.
    from backend.config import settings
    from backend.models.schemas import WireGuardConfig
    from backend.services import wireguard_manager as wgm

    monkeypatch.setattr(settings, "dev_mode", False)
    monkeypatch.setattr(wgm, "WG_CONFIG_DIR", tmp_path)

    # All fields present, but AllowedIPs is a severed, unparseable CIDR.
    truncated_ip = (
        "[Interface]\n"
        "PrivateKey = " + "O" + "l" * 42 + "=\n"
        "Address = 10.13.13.9/32\n"
        "\n"
        "[Peer]\n"
        "PublicKey = " + "P" + "k" * 42 + "=\n"
        "Endpoint = old.endpoint.net:51820\n"
        "AllowedIPs = 10.0.0\n"  # truncated — charset-valid but not an IP network
    )

    async def fake_stored():
        return "S" + "t" * 42 + "="

    async def fake_is_active():
        return True

    async def fake_snapshot():
        return truncated_ip

    writes = []

    async def fake_write(dest, content, mode):
        writes.append(content)
        return True

    touched = []

    async def fake_disable():
        touched.append("disable")
        return True

    async def fake_enable():
        touched.append("enable")
        return True

    monkeypatch.setattr(wgm, "_read_active_config_private_key", fake_stored)
    monkeypatch.setattr(wgm, "_read_stored_private_key", fake_stored)
    monkeypatch.setattr(wgm, "_read_active_config_text", fake_snapshot)
    monkeypatch.setattr(wgm, "_sudo_write", fake_write)
    monkeypatch.setattr(wgm, "_interface_is_active", fake_is_active)
    monkeypatch.setattr(wgm.WireGuardManager, "disable", fake_disable)
    monkeypatch.setattr(wgm.WireGuardManager, "enable", fake_enable)

    cfg = WireGuardConfig(
        private_key="",
        address="10.13.13.2/32",
        peer_public_key="P" + "u" * 42 + "=",
        peer_endpoint="vpn.home.net:51820",
        allowed_ips="0.0.0.0/0",
        use_generated_key=True,
    )
    ok = await wgm.WireGuardManager.configure(cfg)
    assert ok is False
    assert writes == []
    assert touched == []


async def test_wireguard_active_update_refused_with_empty_snapshot(monkeypatch, tmp_path):
    # Gate: an EMPTY (or whitespace-only) live config is no rollback target either.
    # _read_active_config_text returns "" for a readable-but-empty file, which must
    # be refused just like an unreadable one — never overwrite the working tunnel.
    from backend.config import settings
    from backend.models.schemas import WireGuardConfig
    from backend.services import wireguard_manager as wgm

    monkeypatch.setattr(settings, "dev_mode", False)
    monkeypatch.setattr(wgm, "WG_CONFIG_DIR", tmp_path)

    async def fake_stored():
        return "S" + "t" * 42 + "="

    async def fake_is_active():
        return True

    async def fake_empty_snapshot():
        return "   \n"  # readable but empty/whitespace-only → unusable for rollback

    writes = []

    async def fake_write(dest, content, mode):
        writes.append(content)
        return True

    touched = []

    async def fake_disable():
        touched.append("disable")
        return True

    async def fake_enable():
        touched.append("enable")
        return True

    monkeypatch.setattr(wgm, "_read_active_config_private_key", fake_stored)
    monkeypatch.setattr(wgm, "_read_stored_private_key", fake_stored)
    monkeypatch.setattr(wgm, "_read_active_config_text", fake_empty_snapshot)
    monkeypatch.setattr(wgm, "_sudo_write", fake_write)
    monkeypatch.setattr(wgm, "_interface_is_active", fake_is_active)
    monkeypatch.setattr(wgm.WireGuardManager, "disable", fake_disable)
    monkeypatch.setattr(wgm.WireGuardManager, "enable", fake_enable)

    cfg = WireGuardConfig(
        private_key="",
        address="10.13.13.2/32",
        peer_public_key="P" + "u" * 42 + "=",
        peer_endpoint="vpn.home.net:51820",
        allowed_ips="0.0.0.0/0",
        use_generated_key=True,
    )
    ok = await wgm.WireGuardManager.configure(cfg)
    assert ok is False       # refused
    assert writes == []      # config file never overwritten
    assert touched == []     # interface never bounced


async def test_wireguard_edit_preserves_active_identity(monkeypatch, tmp_path):
    # Gate 15c: an empty-key save (an edit) must keep the ACTIVE tunnel identity,
    # not silently swap in whatever /generate-keys last wrote.
    from backend.config import settings
    from backend.models.schemas import WireGuardConfig
    from backend.services import wireguard_manager as wgm

    monkeypatch.setattr(settings, "dev_mode", False)
    monkeypatch.setattr(wgm, "WG_CONFIG_DIR", tmp_path)
    active = "A" + "c" * 42 + "="        # key in the live config
    regenerated = "R" + "g" * 42 + "="   # a DIFFERENT stored key

    async def fake_active():
        return active

    async def fake_stored():
        return regenerated

    written = {}

    async def fake_write(dest, content, mode):
        written["content"] = content
        return True

    async def fake_inactive():
        return False

    monkeypatch.setattr(wgm, "_read_active_config_private_key", fake_active)
    monkeypatch.setattr(wgm, "_read_stored_private_key", fake_stored)
    monkeypatch.setattr(wgm, "_sudo_write", fake_write)
    monkeypatch.setattr(wgm, "_interface_is_active", fake_inactive)

    cfg = WireGuardConfig(
        private_key="",
        address="10.13.13.2/32",
        peer_public_key="P" + "u" * 42 + "=",
        peer_endpoint="new.endpoint.net:51820",  # editing the endpoint
        allowed_ips="0.0.0.0/0",
    )
    ok = await wgm.WireGuardManager.configure(cfg)
    assert ok is True
    assert f"PrivateKey = {active}" in written["content"]   # identity preserved
    assert regenerated not in written["content"]            # NOT the regenerated key


def test_wireguard_save_rejects_camel_case(client):
    # Guard the contract direction: the old camelCase body is missing the required
    # snake_case fields -> 422. (Confirms the frontend fix was necessary.)
    r = client.put(
        "/api/network/wireguard/config",
        json={"privateKey": "x", "peerPublicKey": "y", "peerEndpoint": "z"},
    )
    assert r.status_code == 422


async def test_list_connections_populates_active_ip(monkeypatch):
    # M-F2 root cause: WiFiConnection was built without ip_address, so the active
    # network's IP was always blank in PRODUCTION (dev mock happened to set it).
    # Exercise the real nmcli path with mocked output.
    from backend.config import settings
    from backend.services import network_manager as nm

    monkeypatch.setattr(settings, "dev_mode", False)

    class _R:
        def __init__(self, out):
            self.returncode = 0
            self.stdout = out
            self.stderr = ""

    async def fake_run(script, args=None, timeout=30, cwd=None, env=None, input_data=None):
        a = " ".join(args or [])
        if "IP4.ADDRESS" in a:
            return _R("192.168.7.5/24\n")
        if "autoconnect" in a:
            return _R("connection.autoconnect:yes\nconnection.autoconnect-priority:100\n")
        return _R("HomeWiFi:uuid-1:802-11-wireless:wlan0:yes\n")  # the list

    monkeypatch.setattr(nm.script_runner, "run", fake_run)

    conns = await nm.NetworkManager.list_connections()
    assert len(conns) == 1
    assert conns[0].active is True
    assert conns[0].ip_address == "192.168.7.5"  # populated, CIDR stripped


def test_setup_detect_masks_secrets(client, conf_path):
    # SOL-006: setup endpoints are reachable pre-auth; detected config must mask
    # secrets (WIFIPASS included), not leak them.
    _write_conf(conf_path, 'ARCHIVE_SERVER="nas.local"\nWIFIPASS="s3cret"\nSHARE_PASSWORD="pw"\n')
    r = client.get("/api/setup/detect")
    assert r.status_code == 200
    existing = r.json()["existingConfig"]
    assert existing.get("WIFIPASS") == "********"
    assert existing.get("SHARE_PASSWORD") == "********"
    assert existing.get("ARCHIVE_SERVER") == "nas.local"


# --- Files manager contract (Phase 4, C5) ---------------------------------------

def test_files_ls_returns_structured_response(client):
    # C5: /ls used to return a bare list; the frontend expects
    # {drive, path, parent, entries[]} with camelCase isDirectory and ISO modified.
    r = client.get("/api/files/music/ls?path=/")
    assert r.status_code == 200
    body = r.json()
    assert body["drive"] == "music"
    assert body["path"] == "/"
    assert body["parent"] is None            # root has no parent
    assert isinstance(body["entries"], list) and body["entries"]
    entry = body["entries"][0]
    assert "isDirectory" in entry            # camelCase per the frontend contract
    assert "is_dir" not in entry and "is_directory" not in entry
    assert isinstance(entry["modified"], str)  # ISO string, not a float
    assert isinstance(entry["size"], int)


def test_files_ls_computes_parent(client):
    # Subdirectory listings must report their parent so the UI can navigate up.
    r = client.get("/api/files/cam/ls?path=/TeslaCam")
    assert r.status_code == 200
    body = r.json()
    assert body["path"] == "/TeslaCam"
    assert body["parent"] == "/"


def test_files_rm_requires_confirm(client):
    # Delete must refuse without confirm=true, even with valid paths.
    r = client.post("/api/files/music/rm", json={"paths": ["/playlist.m3u"]})
    assert r.status_code == 400


def test_files_rm_accepts_paths_with_confirm(client):
    # The frontend sends {paths:[...], confirm:true} (multi-select delete).
    r = client.post("/api/files/music/rm", json={"paths": ["/a", "/b"], "confirm": True})
    assert r.status_code == 200


def test_files_mkdir_joins_name(client):
    # mkdir takes a parent path + a name; the new folder is created inside the parent.
    r = client.post("/api/files/music/mkdir", json={"path": "/", "name": "NewFolder"})
    assert r.status_code == 200
    assert "/NewFolder" in r.json()["message"]


def test_files_mkdir_rejects_separator_in_name(client):
    # A name with a path separator would escape the parent dir — reject it.
    r = client.post("/api/files/music/mkdir", json={"path": "/", "name": "a/b"})
    assert r.status_code == 400


def test_files_mv_accepts_dst_field(client):
    # Move uses {src, dst}; the frontend previously sent {src, dest} and got 422.
    r = client.post("/api/files/music/mv", json={"src": "/a", "dst": "/b"})
    assert r.status_code == 200


async def test_files_rm_batch_containment_checked_in_production(monkeypatch, tmp_path):
    # An escaping path anywhere in the batch must 403 before ANY delete happens.
    # Calls the handler directly to avoid the production app lifespan.
    from fastapi import HTTPException
    from backend.config import settings
    from backend.routers import files as files_mod

    monkeypatch.setattr(settings, "dev_mode", False)
    mount = tmp_path / "music"
    mount.mkdir()
    victim = tmp_path / "secret.txt"
    victim.write_text("do not delete")
    real_file = mount / "keep.txt"
    real_file.write_text("keep")
    monkeypatch.setitem(files_mod._DRIVE_MOUNTS, "music", str(mount))

    body = files_mod.DeleteRequest(paths=["/keep.txt", "../secret.txt"], confirm=True)
    try:
        await files_mod.remove_file("music", body)
        assert False, "expected containment rejection"
    except HTTPException as exc:
        assert exc.status_code == 403

    assert victim.exists()      # escaping path blocked
    assert real_file.exists()   # batch aborted before deleting the valid path too


# --- Notifications secret round-trip (Phase 4) ----------------------------------
# The fix is _merge_preserving_secrets, called by upsert_channel to merge an incoming
# config over the stored one before persisting. This is a direct, deterministic unit
# test of that helper. (An earlier attempt to assert the full upsert->DB path proved
# flaky under the async suite — see teslapi_work_log.md iter 20 for the get_db/monkey-
# patch interaction; the upsert wiring is verified manually and by mutation testing.)

def test_notification_merge_preserves_and_drops_secrets():
    # C6/M-B8 for notifications: GET masks secrets and the form echoes the mask back
    # on save, so a naive store would overwrite the real credential with "********".
    from backend.routers.notifications import _merge_preserving_secrets, _MASK, _is_sensitive

    # The mask must be recognized as a sensitive-field sentinel.
    assert _is_sensitive("bot_token") and _is_sensitive("smtp_password")

    # Masked secret + stored value → keep the stored secret; apply non-secret change.
    merged = _merge_preserving_secrets(
        {"bot_token": _MASK, "chat_id": "2"}, {"bot_token": "REAL", "chat_id": "1"}
    )
    assert merged == {"bot_token": "REAL", "chat_id": "2"}

    # Masked secret + nothing stored → drop it (never persist the literal mask).
    merged = _merge_preserving_secrets({"bot_token": _MASK, "chat_id": "9"}, {})
    assert merged == {"chat_id": "9"}

    # A real new secret is stored as-is.
    merged = _merge_preserving_secrets({"bot_token": "NEWREAL"}, {"bot_token": "OLD"})
    assert merged == {"bot_token": "NEWREAL"}


# --- Home Assistant config secret round-trip (Phase 4) --------------------------

def test_ha_preserve_secrets_keeps_masked_values():
    # C6/M-F6: get_ha_config masks token ("abcd...wxyz") and mqtt_password ("********").
    # The form echoes those back on save; masked (unchanged) secrets must be preserved,
    # not written over the real credential (which would also break the live client).
    from backend.models.schemas import HAConfig
    from backend.routers.homeassistant import _preserve_ha_secrets, _looks_masked, _TOKEN_MASK

    saved = HAConfig(url="http://ha.local:8123", token="eyJrealJWTtokenvalue123456", mqtt_password="realmqtt")

    # Masked token + masked mqtt_password echoed back → both preserved.
    incoming = HAConfig(url="http://ha.local:8123", token="eyJr...3456", mqtt_password=_TOKEN_MASK)
    merged = _preserve_ha_secrets(incoming, saved)
    assert merged.token == "eyJrealJWTtokenvalue123456"
    assert merged.mqtt_password == "realmqtt"

    # A genuinely new token is kept as-is.
    incoming2 = HAConfig(url="http://ha.local:8123", token="brandNewTokenValue987654321", mqtt_password="newpw")
    merged2 = _preserve_ha_secrets(incoming2, saved)
    assert merged2.token == "brandNewTokenValue987654321"
    assert merged2.mqtt_password == "newpw"

    # An empty token is a deliberate clear, not a mask → not preserved.
    assert _looks_masked("") is False
    incoming3 = HAConfig(url="http://ha.local:8123", token="", mqtt_password="")
    merged3 = _preserve_ha_secrets(incoming3, saved)
    assert merged3.token == ""

    # A real HA JWT (single dots between segments) is not mistaken for the mask.
    assert _looks_masked("eyJhbGci.eyJzdWIi.SflKxwRJ") is False


# --- System state truthfulness (Phase 5) ----------------------------------------

def test_determine_system_state_emits_all_reachable_states():
    # Phase 5: _determine_system_state used to only ever return ARCHIVING/SYNCING/IDLE,
    # so CONNECTED and ERROR (defined in the schema) were dead. Verify each is reachable
    # and the priority order is truthful (active op > recent failure > connected > idle).
    from backend.models.schemas import MusicSyncStatus, GadgetStatus, SystemState
    from backend.routers.status import _determine_system_state

    def call(job_status=None, syncing=False, enabled=False):
        archive = {"latest_job": {"status": job_status}} if job_status else {"latest_job": None}
        return _determine_system_state(
            archive, MusicSyncStatus(sync_in_progress=syncing), GadgetStatus(enabled=enabled)
        )

    # Active operations take precedence.
    assert call(job_status="running") == SystemState.ARCHIVING
    assert call(syncing=True) == SystemState.SYNCING
    # A running archive wins over a concurrent sync flag.
    assert call(job_status="running", syncing=True) == SystemState.ARCHIVING
    # A recent archive failure surfaces as ERROR when nothing is active.
    assert call(job_status="failed") == SystemState.ERROR
    # ...but an active sync (happening now) outranks a past failure.
    assert call(job_status="failed", syncing=True) == SystemState.SYNCING
    # Gadget presented to the car but idle → CONNECTED, not a bare IDLE.
    assert call(enabled=True) == SystemState.CONNECTED
    # A completed job with the gadget up is still CONNECTED (completed != error).
    assert call(job_status="completed", enabled=True) == SystemState.CONNECTED
    # Nothing happening, gadget down → IDLE.
    assert call() == SystemState.IDLE


# --- Diagnostics: real checks, no dead probe (Phase 5, SOL-022/024) -------------

async def test_diagnostics_runs_promised_checks_without_dead_probe(monkeypatch):
    # SOL-024: the endpoint promised storage/network/gadget/temperature/services but
    # only ran three, and shelled out to a nonexistent run/diagnose.sh. Verify the
    # full set runs with bounded commands and the dead probe is gone.
    from backend.config import settings
    from backend.routers import diagnostics as D

    monkeypatch.setattr(settings, "dev_mode", False)

    class _R:
        def __init__(self, out="", rc=0):
            self.stdout = out
            self.stderr = ""
            self.returncode = rc

    seen_commands = []

    async def fake_run(cmd, args, timeout=None, **kw):
        seen_commands.append((cmd, tuple(args)))
        if cmd == "df":
            return _R("Filesystem Size Used Avail\n/dev/root 30G 5G 24G", 0)
        if cmd == "systemctl":  # ["is-active", <svc>]
            svc = args[1]
            return _R("active" if svc == "teslapi.service" else "inactive", 0)
        if cmd == "cat":  # thermal zone
            return _R("42000", 0)
        if cmd == "bash":
            script = args[-1]
            if "usb_gadget" in script:
                return _R("teslapi\n", 0)   # gadget present
            if "ping" in script:
                return _R("reachable\n", 0)
        return _R("", 0)

    monkeypatch.setattr(D.script_runner, "run", fake_run)

    result = await D.run_diagnostics()
    checks = result["checks"]

    # All five promised areas are present.
    assert set(checks) >= {"storage", "network", "gadget", "temperature", "services"}
    assert checks["gadget"]["status"] == "ok"
    assert checks["temperature"]["details"].startswith("CPU: 42.0")
    # Only the allowlisted services are probed, by exact unit name.
    probed = {a[1] for c, a in seen_commands if c == "systemctl"}
    assert probed == set(D._DIAG_SERVICES)
    # teslapi active, others inactive → services warning surfaces the real state.
    assert checks["services"]["status"] == "warning"
    assert "teslapi.service: active" in checks["services"]["details"]
    # The dead run/diagnose.sh probe is gone.
    assert "diagnose_output" not in result
    assert not any("diagnose.sh" in " ".join(a) for c, a in seen_commands)


# --- System info: real CPU usage + stripped fields (Phase 5, SOL-017 backend) ---

class _RunResult:
    def __init__(self, out="", rc=0):
        self.stdout = out
        self.stderr = ""
        self.returncode = rc


async def test_cpu_usage_computed_from_proc_stat_delta(monkeypatch):
    # SystemStatus had no cpu_usage field, so the dashboard always showed 0%. It's now
    # computed from the delta between successive /proc/stat reads (no blocking sleep).
    from backend.routers import status as S

    monkeypatch.setattr(S, "_prev_cpu_sample", None)
    samples = iter([
        "cpu  100 0 100 800 0 0 0 0 0 0\n",  # total=1000, idle=800
        "cpu  150 0 150 900 0 0 0 0 0 0\n",  # total=1200, idle=900 → Δtotal=200, Δidle=100
    ])

    async def fake_run(cmd, args=None, timeout=None, **kw):
        return _RunResult(next(samples))

    monkeypatch.setattr(S.script_runner, "run", fake_run)

    first = await S._read_cpu_usage()
    assert first == 0.0  # first call has no baseline
    second = await S._read_cpu_usage()
    assert second == 50.0  # 100*(200-100)/200


async def test_cpu_usage_handles_unreadable_proc_stat(monkeypatch):
    from backend.routers import status as S
    monkeypatch.setattr(S, "_prev_cpu_sample", None)

    async def fake_run(cmd, args=None, timeout=None, **kw):
        return _RunResult("", rc=1)

    monkeypatch.setattr(S.script_runner, "run", fake_run)
    assert await S._read_cpu_usage() == 0.0  # never raises


async def test_system_info_strips_command_output(monkeypatch):
    # hostname / wifi_ssid / ip_address were assigned raw stdout WITH the trailing
    # newline — the SSID newline breaks home-network matching. Verify they're stripped.
    from backend.routers import status as S
    monkeypatch.setattr(S, "_prev_cpu_sample", None)

    async def fake_run(cmd, args=None, timeout=None, **kw):
        a = args or []
        if cmd == "hostname":            # bare hostname command
            return _RunResult("teslapi-box\n")
        if cmd == "iwgetid":
            return _RunResult("MyNetwork\n")
        if cmd == "cat" and a and a[0] == "/proc/stat":
            return _RunResult("cpu 1 1 1 1\n")
        if cmd == "bash":
            script = a[-1] if a else ""
            if "hostname -I" in script:
                return _RunResult("10.0.0.9\n")
            return _RunResult("")        # iwconfig signal (empty)
        return _RunResult("")            # os-release, uptime, thermal, meminfo

    monkeypatch.setattr(S.script_runner, "run", fake_run)

    info = await S._read_system_info()
    assert info.hostname == "teslapi-box"     # no trailing newline
    assert info.wifi_ssid == "MyNetwork"
    assert info.ip_address == "10.0.0.9"


# --- Auto-sync persistence (Phase 5, SOL-021) -----------------------------------

async def test_auto_sync_persists_and_reloads_choice(monkeypatch):
    # SOL-021: enabled/interval lived only in memory, so disabling auto-sync reset to
    # enabled on every boot. configure() now persists; start()/load_persisted() reload.
    from backend.services import auto_sync
    from backend import database

    store: dict[str, str] = {}

    async def fake_set(k, v):
        store[k] = v

    async def fake_get(k, default=None):
        return store.get(k, default)

    monkeypatch.setattr(database, "set_setting", fake_set)
    monkeypatch.setattr(database, "get_setting", fake_get)

    orig = dict(auto_sync._state)
    try:
        # User disables auto-sync and sets a 120s interval → persisted.
        await auto_sync.configure(enabled=False, check_interval=120)
        assert store["auto_sync_enabled"] == "false"
        assert store["auto_sync_check_interval"] == "120"

        # Simulate a reboot: in-memory state resets to the enabled-by-default.
        auto_sync._state["enabled"] = True
        auto_sync._state["check_interval"] = 300

        # load_persisted (called by start()) must restore the user's choice.
        await auto_sync.load_persisted()
        assert auto_sync._state["enabled"] is False
        assert auto_sync._state["check_interval"] == 120
    finally:
        auto_sync._state.update(orig)


async def test_auto_sync_interval_floor_and_bad_value(monkeypatch):
    from backend.services import auto_sync
    from backend import database

    store: dict[str, str] = {}

    async def fake_set(k, v):
        store[k] = v

    async def fake_get(k, default=None):
        return store.get(k, default)

    monkeypatch.setattr(database, "set_setting", fake_set)
    monkeypatch.setattr(database, "get_setting", fake_get)

    orig = dict(auto_sync._state)
    try:
        # Below-floor interval is clamped to 60 (both in state and persisted).
        await auto_sync.configure(check_interval=30)
        assert auto_sync._state["check_interval"] == 60
        assert store["auto_sync_check_interval"] == "60"

        # A corrupt persisted interval is ignored, not crashed on.
        store["auto_sync_check_interval"] = "not-a-number"
        auto_sync._state["check_interval"] = 300
        await auto_sync.load_persisted()
        assert auto_sync._state["check_interval"] == 300  # unchanged, no raise
    finally:
        auto_sync._state.update(orig)


# --- Music image capacity contract (Phase 6, M-F9) ------------------------------

def test_local_music_reports_capacity_bytes(client):
    # M-F9: the on-Tesla usage bar hardcoded 1.7 TB, so a full 20 GB drive read ~0%.
    # The response must carry a real capacity_bytes for the UI to size the bar.
    r = client.get("/api/music/local")
    assert r.status_code == 200
    body = r.json()
    assert "capacity_bytes" in body
    assert isinstance(body["capacity_bytes"], int) and body["capacity_bytes"] > 0


# --- Dashcam archived-event detail from DB (Phase 4, H2/SOL-013) -----------------

async def test_dashcam_event_detail_reads_from_db(monkeypatch, tmp_path):
    # H2: the detail endpoint scanned /mnt/cam (unmounted while the gadget is active),
    # so every archived event 404'd. It now reads the dashcam_archived_clips DB.
    import sqlite3
    from backend.config import settings
    from backend import database
    from backend.routers import dashcam as D

    dbp = str(tmp_path / "dash.db")
    monkeypatch.setattr(settings, "database_path", dbp)
    await database.init_db()

    # Seed with a synchronous connection (fully committed before the async read).
    con = sqlite3.connect(dbp)
    con.executemany(
        "INSERT INTO dashcam_archived_clips (event_type, event_dir, clip_file, size_bytes) "
        "VALUES (?,?,?,?)",
        [
            ("SentryClips", "2026-04-12_10-00-02", "2026-04-12_10-00-02-front.mp4", 100),
            ("SentryClips", "2026-04-12_10-00-02", "2026-04-12_10-00-02-back.mp4", 100),
        ],
    )
    con.commit()
    con.close()

    detail = await D._get_event_detail_from_db("sentry__2026-04-12_10-00-02")
    assert detail is not None
    assert detail.type == "sentry"
    assert detail.archived is True
    assert len(detail.clips) == 1  # one timestamp, two cameras
    assert set(detail.clips[0].cameras.keys()) == {"front", "back"}
    assert detail.clips[0].cameras["front"] == (
        "/api/dashcam/video/SentryClips/2026-04-12_10-00-02/2026-04-12_10-00-02-front.mp4"
    )
    assert detail.timestamp == "2026-04-12T10:00:02"

    # An unknown event returns None (endpoint maps that to 404) — no /mnt/cam scan.
    assert await D._get_event_detail_from_db("sentry__1999-01-01_00-00-00") is None
    # A malformed id returns None too.
    assert await D._get_event_detail_from_db("no-separator") is None
