"""App authentication — single shared password with stateless signed session cookies.

Designed for a single-user home device, not multi-user accounts. The gate is dormant
until a password is set (`is_auth_configured()` is False), so existing installs keep
working and enabling auth is an explicit opt-in by setting a password.

Storage (in the app_settings key/value table):
  auth_password_hash  pbkdf2 hash of the shared password ("" / absent = auth disabled)
  auth_secret         per-install HMAC secret for signing session cookies

Session cookie value: "<expiry_epoch>.<hex_hmac>", signed with auth_secret. Stateless —
no server-side session store to keep in sync; revocation is by rotating auth_secret
(logout-everywhere = change password).
"""

import hashlib
import hmac
import logging
import secrets
import time

from backend import database

logger = logging.getLogger(__name__)

_PW_KEY = "auth_password_hash"
_SECRET_KEY = "auth_secret"

_PBKDF2_ITERS = 200_000
SESSION_COOKIE = "teslapi_session"
SESSION_TTL_SECONDS = 7 * 24 * 3600  # 7 days


# --- password hashing -------------------------------------------------------

def hash_password(password: str) -> str:
    """Return a self-describing pbkdf2 hash: 'pbkdf2_sha256$<iters>$<salt>$<hash>'."""
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, _PBKDF2_ITERS)
    return f"pbkdf2_sha256${_PBKDF2_ITERS}${salt.hex()}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    """Constant-time verify a password against a stored pbkdf2 hash."""
    try:
        algo, iters_s, salt_hex, hash_hex = stored.split("$")
        if algo != "pbkdf2_sha256":
            return False
        dk = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), bytes.fromhex(salt_hex), int(iters_s)
        )
        return hmac.compare_digest(dk.hex(), hash_hex)
    except (ValueError, AttributeError):
        return False


# --- password storage -------------------------------------------------------

async def is_auth_configured() -> bool:
    """True if a password has been set (i.e. the gate is active)."""
    h = await database.get_setting(_PW_KEY)
    return bool(h)


async def set_password(new_password: str) -> None:
    """Set/replace the shared password and rotate the session secret.

    Rotating the secret invalidates every existing session cookie, so changing the
    password logs out all clients — the expected behavior for a shared credential.
    """
    if not new_password or len(new_password) < 4:
        raise ValueError("Password must be at least 4 characters")
    await database.set_setting(_PW_KEY, hash_password(new_password))
    await database.set_setting(_SECRET_KEY, secrets.token_hex(32))
    logger.info("App auth password set/changed; existing sessions invalidated")


async def clear_password() -> None:
    """Disable the gate by removing the stored password."""
    await database.set_setting(_PW_KEY, "")
    logger.info("App auth disabled (password cleared)")


async def check_password(password: str) -> bool:
    stored = await database.get_setting(_PW_KEY)
    if not stored:
        return False
    return verify_password(password, stored)


# --- session cookies --------------------------------------------------------

async def _get_secret() -> str:
    secret = await database.get_setting(_SECRET_KEY)
    if not secret:
        secret = secrets.token_hex(32)
        await database.set_setting(_SECRET_KEY, secret)
    return secret


def _sign(payload: str, secret: str) -> str:
    return hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()


async def make_session_token(ttl: int = SESSION_TTL_SECONDS, now: float | None = None) -> str:
    """Create a signed session token valid for ``ttl`` seconds."""
    secret = await _get_secret()
    exp = int((now if now is not None else time.time()) + ttl)
    return f"{exp}.{_sign(str(exp), secret)}"


async def verify_session_token(token: str | None, now: float | None = None) -> bool:
    """Validate a session token's signature and expiry (constant-time)."""
    if not token or "." not in token:
        return False
    exp_s, sig = token.rsplit(".", 1)
    secret = await _get_secret()
    expected = _sign(exp_s, secret)
    if not hmac.compare_digest(sig, expected):
        return False
    try:
        exp = int(exp_s)
    except ValueError:
        return False
    return exp > (now if now is not None else time.time())
