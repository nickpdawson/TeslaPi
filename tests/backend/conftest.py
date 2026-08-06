"""Pytest fixtures for the TeslaPi backend API tests.

Runs the real FastAPI app in dev mode. Every test gets its OWN temp database and
teslausb config (via tmp_path), so tests never touch real state and can't pollute
each other. Dev mode + a non-existent static dir are forced via env before
backend.config is imported.
"""

import os
import tempfile

# Force dev mode before backend.config reads env at import. (DB/config paths are set
# per-test in fixtures below — isolation.)
os.environ["TESLAPI_DEV_MODE"] = "true"
# Point static_dir at a path that doesn't exist so the SPA mount is skipped (no
# dependency on a built frontend/dist).
os.environ["TESLAPI_STATIC_DIR"] = os.path.join(tempfile.gettempdir(), "teslapi-no-static-xyz")

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


@pytest.fixture
def conf_path(tmp_path, monkeypatch):
    """A fresh, empty teslausb config file for this test only."""
    p = tmp_path / "teslausb.conf"
    p.write_text("")
    from backend.config import settings
    monkeypatch.setattr(settings, "teslausb_config_path", str(p))
    return str(p)


@pytest.fixture
def db_path(tmp_path, monkeypatch):
    """A fresh per-test sqlite database path (settings patched to it)."""
    p = str(tmp_path / "test.db")
    from backend.config import settings
    monkeypatch.setattr(settings, "database_path", p)
    return p


@pytest.fixture
def client(db_path, conf_path):
    """TestClient bound to the app with a fresh per-test database + config."""
    from backend.main import app
    with TestClient(app) as c:
        yield c
