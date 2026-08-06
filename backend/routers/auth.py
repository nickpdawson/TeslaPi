"""Authentication endpoints: login, logout, status, set/change password."""

import logging

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel

from backend.config import settings
from backend.services import auth

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/auth")


class LoginRequest(BaseModel):
    password: str


class SetPasswordRequest(BaseModel):
    new_password: str
    current_password: str | None = None


def _set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=auth.SESSION_COOKIE,
        value=token,
        max_age=auth.SESSION_TTL_SECONDS,
        httponly=True,
        samesite="lax",
        # Not Secure: the device is commonly reached over plain HTTP on the LAN / the
        # Tesla browser. nginx/WireGuard provide the transport boundary.
        secure=False,
        path="/",
    )


@router.get("/status")
async def auth_status(request: Request) -> dict:
    """Whether auth is configured and whether THIS request is authenticated.

    Unprotected so the frontend can decide between the login screen and the app.
    """
    configured = await auth.is_auth_configured()
    authenticated = True
    if configured:
        token = request.cookies.get(auth.SESSION_COOKIE)
        authenticated = await auth.verify_session_token(token)
    return {"configured": configured, "authenticated": authenticated}


@router.post("/login")
async def login(req: LoginRequest, response: Response) -> dict:
    """Exchange the shared password for a session cookie."""
    if not await auth.is_auth_configured():
        raise HTTPException(status_code=400, detail="Auth is not configured")
    if not await auth.check_password(req.password):
        raise HTTPException(status_code=401, detail="Incorrect password")
    token = await auth.make_session_token()
    _set_session_cookie(response, token)
    return {"ok": True}


@router.post("/logout")
async def logout(response: Response) -> dict:
    """Clear the session cookie on this client."""
    response.delete_cookie(auth.SESSION_COOKIE, path="/")
    return {"ok": True}


@router.post("/set-password")
async def set_password(req: SetPasswordRequest, request: Request, response: Response) -> dict:
    """Set the initial password, or change it.

    First-time set (no password configured yet) is allowed without a credential — the
    device is assumed to be on a trusted network during setup, same trust model as the
    rest of first-run setup. Changing an EXISTING password requires either the current
    password or an already-authenticated session.
    """
    already = await auth.is_auth_configured()
    if already:
        authed = await auth.verify_session_token(request.cookies.get(auth.SESSION_COOKIE))
        current_ok = bool(req.current_password) and await auth.check_password(req.current_password)
        if not (authed or current_ok):
            raise HTTPException(status_code=403, detail="Current password or an active session required")

    try:
        await auth.set_password(req.new_password)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    # Issue a fresh session so the caller stays logged in after the secret rotation.
    _set_session_cookie(response, await auth.make_session_token())
    return {"ok": True}


@router.post("/disable")
async def disable_auth(request: Request) -> dict:
    """Turn the gate off (clear the password). Requires an authenticated session."""
    if await auth.is_auth_configured():
        if not await auth.verify_session_token(request.cookies.get(auth.SESSION_COOKIE)):
            raise HTTPException(status_code=403, detail="Authentication required")
    await auth.clear_password()
    return {"ok": True}
