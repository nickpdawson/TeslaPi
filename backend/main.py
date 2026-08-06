"""TeslaPi FastAPI application."""

import asyncio
import logging
from contextlib import asynccontextmanager
from importlib.metadata import version as pkg_version
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from backend.config import settings
from backend.database import init_db
from backend.services import auth as auth_service
from backend.routers import (
    archive,
    auth,
    auto_sync,
    config,
    customization,
    dashcam,
    diagnostics,
    files,
    gadget,
    homeassistant,
    music,
    network,
    notifications,
    setup,
    shares,
    status,
    system,
    updates,
)

logger = logging.getLogger(__name__)


def _get_version() -> str:
    # The deployed VERSION file (line 1 = semver) is the source of truth — a deploy
    # copies backend/ but does not reinstall the pip package, so pkg_version() metadata
    # goes stale. The updater reads this same file; keep /api/health consistent with it.
    try:
        version_file = Path("/opt/teslapi/VERSION")
        if version_file.exists():
            first = version_file.read_text().splitlines()[0].strip()
            if first:
                return first
    except Exception:
        pass
    try:
        return pkg_version("teslapi")
    except Exception:
        return "0.2.0"


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize database on startup, clean up on shutdown."""
    logging.basicConfig(
        level=logging.DEBUG if settings.dev_mode else logging.INFO,
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    )
    logger.info(
        "TeslaPi starting (dev_mode=%s, port=%d)", settings.dev_mode, settings.port
    )
    await init_db()

    # Reconcile jobs left 'running'/'pending' by a prior crash or restart — no sync
    # process survives a restart, so such rows are orphaned and would otherwise pin
    # the dashboard on "syncing" forever (and mask that the drive is actually idle).
    from backend.database import reconcile_interrupted_jobs
    await reconcile_interrupted_jobs()

    # Start auto-sync background loop
    from backend.services import auto_sync as _auto_sync

    _auto_sync_task = asyncio.create_task(_auto_sync.start())
    _auto_sync._state["task"] = _auto_sync_task
    logger.info("Auto-sync background loop registered")

    # Start the auto-update-check loop (checks only; never auto-applies)
    from backend.services.updater import updater as _updater

    _update_check_task = asyncio.create_task(_updater.run_auto_check_loop())
    logger.info("Auto-update-check background loop registered")

    # Start Home Assistant background push loop if configured
    from backend.services import ha_client as _ha_client

    try:
        from backend.routers.homeassistant import _load_ha_config

        ha_config = await _load_ha_config()
        if ha_config.enabled and ha_config.url and ha_config.token:
            mqtt_cfg = None
            if ha_config.mqtt_broker:
                mqtt_cfg = {
                    "broker": ha_config.mqtt_broker,
                    "port": ha_config.mqtt_port,
                    "username": ha_config.mqtt_username,
                    "password": ha_config.mqtt_password,
                }
            _ha_client.configure_client(
                url=ha_config.url, token=ha_config.token, mqtt_config=mqtt_cfg
            )
            _ha_client.start_push_loop()
            logger.info("HA push loop auto-started from saved config")
    except Exception as exc:
        logger.debug("HA auto-start skipped: %s", exc)

    yield

    # Shutdown: stop auto-sync loop
    await _auto_sync.stop()

    # Shutdown: stop the auto-update-check loop
    _update_check_task.cancel()
    try:
        await _update_check_task
    except asyncio.CancelledError:
        pass

    # Shutdown: stop HA push loop and disconnect MQTT
    _ha_client.stop_push_loop()
    client = _ha_client.get_client()
    if client:
        client.disconnect_mqtt()
    logger.info("TeslaPi shutting down")


app = FastAPI(
    title="TeslaPi API",
    version=_get_version(),
    lifespan=lifespan,
)

# CORS middleware
if settings.dev_mode:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
else:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "DELETE"],
        allow_headers=["*"],
    )

# Auth gate: once a password is set, every /api/* request needs a valid session
# cookie — except health (monitoring), the auth endpoints themselves (login/status),
# and setup (must run before auth exists). Dormant until a password is configured, so
# existing installs are unaffected until the owner opts in by setting one.
_AUTH_EXEMPT_PREFIXES = ("/api/auth/", "/api/setup/")
_AUTH_EXEMPT_EXACT = ("/api/health", "/api/auth", "/api/setup")


def _auth_exempt(path: str) -> bool:
    return path in _AUTH_EXEMPT_EXACT or path.startswith(_AUTH_EXEMPT_PREFIXES)


@app.middleware("http")
async def _auth_gate(request: Request, call_next):
    path = request.url.path
    if path.startswith("/api/") and not _auth_exempt(path):
        if await auth_service.is_auth_configured():
            token = request.cookies.get(auth_service.SESSION_COOKIE)
            if not await auth_service.verify_session_token(token):
                return JSONResponse(
                    status_code=401, content={"detail": "Authentication required"}
                )
    return await call_next(request)


# API routers
app.include_router(auth.router, prefix="/api", tags=["auth"])
app.include_router(status.router, prefix="/api", tags=["status"])
app.include_router(archive.router, prefix="/api", tags=["archive"])
app.include_router(system.router, prefix="/api", tags=["system"])
app.include_router(config.router, prefix="/api", tags=["config"])
app.include_router(customization.router, prefix="/api", tags=["customization"])
app.include_router(gadget.router, prefix="/api", tags=["gadget"])
app.include_router(diagnostics.router, prefix="/api", tags=["diagnostics"])
app.include_router(files.router, prefix="/api", tags=["files"])
app.include_router(dashcam.router, prefix="/api", tags=["dashcam"])
app.include_router(homeassistant.router, prefix="/api", tags=["homeassistant"])
app.include_router(notifications.router, prefix="/api", tags=["notifications"])
app.include_router(music.router, prefix="/api", tags=["music"])
app.include_router(shares.router, prefix="/api", tags=["shares"])
app.include_router(network.router, prefix="/api", tags=["network"])
app.include_router(setup.router, prefix="/api", tags=["setup"])
app.include_router(updates.router, prefix="/api", tags=["updates"])
app.include_router(auto_sync.router, prefix="/api", tags=["auto-sync"])


@app.get("/api/health")
async def health_check() -> dict:
    """Health check endpoint for monitoring and load balancers."""
    return {
        "status": "ok",
        "version": _get_version(),
        "dev_mode": settings.dev_mode,
    }


# Static file serving for the frontend SPA (production only)
_static_dir = Path(settings.static_dir)
if _static_dir.is_dir():
    app.mount("/assets", StaticFiles(directory=str(_static_dir / "assets")), name="assets")

    _static_root = _static_dir.resolve()

    @app.get("/{full_path:path}")
    async def serve_spa(request: Request, full_path: str) -> FileResponse:
        """Serve the SPA index.html for all non-API routes (client-side routing)."""
        # Try to serve the exact file first — but only if it resolves to a real file
        # strictly inside the static root. Starlette does NOT collapse `..` in the
        # path param, so without this containment check `GET /../../etc/passwd`
        # (via a client that doesn't normalize) would read arbitrary files.
        if full_path:
            candidate = (_static_root / full_path).resolve()
            if candidate.is_relative_to(_static_root) and candidate.is_file():
                return FileResponse(str(candidate))
        # Fall back to index.html for SPA routing
        return FileResponse(str(_static_root / "index.html"))
