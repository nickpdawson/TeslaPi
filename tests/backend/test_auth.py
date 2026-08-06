"""Auth gate: password hashing, session tokens, and the middleware enforcement."""
import asyncio

from backend.services import auth


# --- pure crypto (no DB) ----------------------------------------------------

def test_hash_and_verify_password():
    h = auth.hash_password("hunter2")
    assert h.startswith("pbkdf2_sha256$")
    assert auth.verify_password("hunter2", h)
    assert not auth.verify_password("Hunter2", h)     # case-sensitive
    assert not auth.verify_password("wrong", h)
    assert not auth.verify_password("hunter2", "garbage")   # malformed stored hash
    assert not auth.verify_password("hunter2", "")


def test_hash_is_salted_unique():
    assert auth.hash_password("x") != auth.hash_password("x")  # random salt each time


def test_session_token_roundtrip_and_expiry(db_path):
    async def go():
        from backend.database import init_db
        await init_db()
        now = 1_000_000.0
        tok = await auth.make_session_token(ttl=100, now=now)
        assert await auth.verify_session_token(tok, now=now + 50)      # within ttl
        assert not await auth.verify_session_token(tok, now=now + 200)  # expired
        assert not await auth.verify_session_token(None, now=now)
        assert not await auth.verify_session_token(tok[:-1] + "0", now=now + 50)  # tampered sig
    asyncio.run(go())


# --- middleware gate (HTTP) -------------------------------------------------

def test_gate_is_dormant_until_password_set(client):
    r = client.get("/api/auth/status")
    assert r.json() == {"configured": False, "authenticated": True}
    # protected endpoint is reachable while no password is configured
    assert client.get("/api/status").status_code == 200


def test_gate_blocks_without_session_then_login_grants_access(client):
    # first-time password set is allowed without a credential
    assert client.post("/api/auth/set-password", json={"new_password": "hunter2"}).status_code == 200
    client.cookies.clear()  # drop the session cookie set-password issued

    # now gated: a protected endpoint requires a session
    assert client.get("/api/status").status_code == 401
    # exempt endpoints still work unauthenticated
    assert client.get("/api/health").status_code == 200
    assert client.get("/api/auth/status").json()["configured"] is True
    assert client.get("/api/auth/status").json()["authenticated"] is False

    # wrong password rejected
    assert client.post("/api/auth/login", json={"password": "nope"}).status_code == 401
    assert client.get("/api/status").status_code == 401

    # correct password -> session cookie -> access granted
    assert client.post("/api/auth/login", json={"password": "hunter2"}).status_code == 200
    assert client.get("/api/status").status_code == 200
    assert client.get("/api/auth/status").json()["authenticated"] is True

    # logout revokes access on this client
    assert client.post("/api/auth/logout").status_code == 200
    assert client.get("/api/status").status_code == 401


def test_tampered_cookie_is_rejected(client):
    assert client.post("/api/auth/set-password", json={"new_password": "hunter2"}).status_code == 200
    client.cookies.clear()
    client.cookies.set(auth.SESSION_COOKIE, "9999999999.deadbeef")  # bogus signature
    assert client.get("/api/status").status_code == 401


def test_change_password_requires_current_or_session(client):
    assert client.post("/api/auth/set-password", json={"new_password": "first"}).status_code == 200
    client.cookies.clear()
    # no session, no current password -> refused
    r = client.post("/api/auth/set-password", json={"new_password": "second"})
    assert r.status_code == 403
    # with the current password -> allowed
    r = client.post("/api/auth/set-password", json={"new_password": "second", "current_password": "first"})
    assert r.status_code == 200
