"""Diagnostics and log streaming endpoints."""

import asyncio
import logging
from pathlib import Path

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from backend.config import settings
from backend.services import script_runner

logger = logging.getLogger(__name__)
router = APIRouter()

# Allowed log files to prevent arbitrary file reads
_ALLOWED_LOGS = {
    "syslog": "/var/log/syslog",
    "teslausb": "/var/log/teslausb.log",
    "archive": "/var/log/archive.log",
    "kern": "/var/log/kern.log",
    "dmesg": "/var/log/dmesg",
}

# Services checked by the "services" diagnostic — a fixed allowlist so the name is
# never attacker-influenced. These are the units TeslaPi's install enables.
_DIAG_SERVICES = ("teslapi.service", "teslausb.service", "nginx.service")


@router.get("/diagnostics")
async def run_diagnostics() -> dict:
    """Run system diagnostics with bounded, allowlisted probes.

    Returns a structured check per area: storage, network, gadget, temperature, and
    services — the same set the UI expects. (There is no run/diagnose.sh; the checks
    below are the real implementation.)
    """
    if settings.dev_mode:
        return {
            "status": "ok",
            "checks": {
                "storage": {"status": "ok", "details": "All mounts healthy"},
                "network": {"status": "ok", "details": "WiFi connected, archive server reachable"},
                "gadget": {"status": "ok", "details": "USB gadget active with 4 drives"},
                "temperature": {"status": "ok", "details": "CPU: 38.2C"},
                "services": {"status": "ok", "details": "All services running"},
            },
        }

    checks: dict[str, dict[str, str]] = {}

    # Storage check
    df_result = await script_runner.run("df", ["-h"], timeout=10)
    checks["storage"] = {
        "status": "ok" if df_result.returncode == 0 else "error",
        "details": df_result.stdout[:500] if df_result.returncode == 0 else df_result.stderr,
    }

    # Network check
    ping_result = await script_runner.run(
        "bash", ["-c", "ping -c 1 -W 3 8.8.8.8 >/dev/null 2>&1 && echo reachable || echo unreachable"],
        timeout=10,
    )
    checks["network"] = {
        "status": "ok" if "reachable" in ping_result.stdout else "warning",
        "details": ping_result.stdout.strip(),
    }

    # Gadget check — is the USB mass-storage gadget presented to the car?
    gadget_result = await script_runner.run(
        "bash", ["-c", "ls /sys/kernel/config/usb_gadget/ 2>/dev/null"], timeout=5
    )
    gadget_active = bool(gadget_result.stdout.strip())
    checks["gadget"] = {
        "status": "ok" if gadget_active else "warning",
        "details": "USB gadget active" if gadget_active else "USB gadget not configured",
    }

    # Temperature
    temp_result = await script_runner.run(
        "cat", ["/sys/class/thermal/thermal_zone0/temp"], timeout=5
    )
    if temp_result.returncode == 0:
        try:
            temp_c = int(temp_result.stdout) / 1000.0
            checks["temperature"] = {
                "status": "warning" if temp_c > 70 else "ok",
                "details": f"CPU: {temp_c:.1f}C",
            }
        except ValueError:
            checks["temperature"] = {"status": "unknown", "details": "Could not read temperature"}
    else:
        checks["temperature"] = {"status": "unknown", "details": "Could not read temperature"}

    # Services check — each unit name comes from the fixed allowlist above.
    states = []
    all_active = True
    for svc in _DIAG_SERVICES:
        r = await script_runner.run("systemctl", ["is-active", svc], timeout=5)
        state = r.stdout.strip() or "unknown"
        if state != "active":
            all_active = False
        states.append(f"{svc}: {state}")
    checks["services"] = {
        "status": "ok" if all_active else "warning",
        "details": "; ".join(states),
    }

    return {
        "status": "ok" if all(c["status"] == "ok" for c in checks.values()) else "warning",
        "checks": checks,
    }


@router.websocket("/ws/logs/{logname}")
async def stream_logs(websocket: WebSocket, logname: str) -> None:
    """Stream log file changes in real-time via WebSocket.

    Tails the specified log file and pushes new lines to the client.
    Supported log names: syslog, teslausb, archive, kern, dmesg.
    """
    if logname not in _ALLOWED_LOGS:
        await websocket.close(code=4004, reason=f"Unknown log: {logname}")
        return

    await websocket.accept()
    log_path = Path(_ALLOWED_LOGS[logname])

    if settings.dev_mode:
        # In dev mode, send some fake log lines then keep alive
        await websocket.send_text(f"[dev] Streaming {logname} (mock mode)")
        try:
            while True:
                await asyncio.sleep(5)
                await websocket.send_text(f"[dev] {logname}: heartbeat")
        except WebSocketDisconnect:
            return

    if not log_path.exists():
        await websocket.send_text(f"Log file not found: {log_path}")
        await websocket.close()
        return

    try:
        # Use tail -F to follow the log file, surviving rotations
        proc = await asyncio.create_subprocess_exec(
            "tail", "-n", "50", "-F", str(log_path),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )

        async def read_output() -> None:
            assert proc.stdout is not None
            while True:
                line = await proc.stdout.readline()
                if not line:
                    break
                await websocket.send_text(line.decode("utf-8", errors="replace").rstrip())

        # Run the reader; cancel on disconnect
        reader_task = asyncio.create_task(read_output())
        try:
            # Wait for client disconnect
            while True:
                await websocket.receive_text()
        except WebSocketDisconnect:
            pass
        finally:
            reader_task.cancel()
            proc.kill()
            await proc.wait()

    except Exception as exc:
        logger.error("Log streaming error for %s: %s", logname, exc)
        try:
            await websocket.close(code=1011, reason=str(exc))
        except Exception:
            pass
