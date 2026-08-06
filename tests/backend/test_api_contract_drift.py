"""Phase 4 guard: every literal frontend API path must resolve to a backend route.

This catches the whole class of contract-drift bugs (frontend calling an endpoint the
backend doesn't define -> 404/405) statically, so they can't silently re-drift. It
checks PATHS only (not request/response shapes); template-literal paths with runtime
variables are skipped since they can't be matched statically.
"""
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


def _backend_routes() -> set[str]:
    routes = set()
    for f in (REPO / "backend" / "routers").glob("*.py"):
        txt = f.read_text()
        m = re.search(r'APIRouter\(prefix="([^"]*)"', txt)
        prefix = m.group(1) if m else ""
        for _meth, path in re.findall(r'@router\.(get|post|put|delete)\("([^"]*)"', txt):
            full = (prefix + path).rstrip("/") or "/"
            routes.add(full)
    return routes


def _frontend_paths() -> set[str]:
    paths = set()
    pat = re.compile(r"\b(?:get|post|put|del)\s*(?:<[^>]*>)?\(\s*'(/[^']*)'")
    for f in (REPO / "frontend" / "src").rglob("*.ts*"):
        for m in pat.finditer(f.read_text()):
            p = m.group(1)
            if "${" in p or p == "/":   # skip runtime-templated paths
                continue
            p = p.split("?", 1)[0]      # query string is not part of the route path
            paths.add(p.rstrip("/") or "/")
    return paths


def _matches(fp: str, routes: set[str]) -> bool:
    for bp in routes:
        rx = "^" + re.sub(r"\\\{[^}]+\\\}", r"[^/]+", re.escape(bp)) + "$"
        if re.match(rx, fp):
            return True
    return False


def test_no_frontend_api_path_is_missing_a_backend_route():
    routes = _backend_routes()
    assert routes, "no backend routes parsed — parser broke"
    fe = _frontend_paths()
    assert fe, "no frontend API paths parsed — parser broke"
    missing = sorted(fp for fp in fe if not _matches(fp, routes))
    assert not missing, (
        "Frontend calls backend endpoints that don't exist (contract drift):\n  "
        + "\n  ".join(missing)
    )
