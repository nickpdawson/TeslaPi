"""Async subprocess wrapper for executing bash scripts."""

import asyncio
import logging
import time
from dataclasses import dataclass, field

from backend.config import settings

logger = logging.getLogger(__name__)


@dataclass
class ScriptResult:
    returncode: int
    stdout: str
    stderr: str
    duration: float
    timed_out: bool = False


@dataclass
class MockResult:
    """Pre-configured mock results for dev mode."""
    returncode: int = 0
    stdout: str = ""
    stderr: str = ""
    _registry: dict[str, "MockResult"] = field(default_factory=dict, repr=False)


# Mock data registry for dev mode
_mock_results: dict[str, ScriptResult] = {}


def register_mock(script: str, result: ScriptResult) -> None:
    """Register a mock result for a script path (dev mode only)."""
    _mock_results[script] = result


async def run(
    script: str,
    args: list[str] | None = None,
    timeout: int = 30,
    cwd: str | None = None,
) -> ScriptResult:
    """Execute a bash script asynchronously.

    Args:
        script: Path to the script or command to run.
        args: Command-line arguments.
        timeout: Maximum execution time in seconds.
        cwd: Working directory for the script.

    Returns:
        ScriptResult with output, exit code, and timing.
    """
    if settings.dev_mode and script in _mock_results:
        logger.debug("Dev mode: returning mock result for %s", script)
        return _mock_results[script]

    cmd = [script] + (args or [])
    cmd_str = " ".join(cmd)
    logger.debug("Running: %s (timeout=%ds, cwd=%s)", cmd_str, timeout, cwd)

    start = time.monotonic()
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd,
        )
        stdout_bytes, stderr_bytes = await asyncio.wait_for(
            proc.communicate(), timeout=timeout
        )
        duration = time.monotonic() - start

        result = ScriptResult(
            returncode=proc.returncode or 0,
            stdout=stdout_bytes.decode("utf-8", errors="replace").strip(),
            stderr=stderr_bytes.decode("utf-8", errors="replace").strip(),
            duration=duration,
        )

        if result.returncode != 0:
            logger.warning(
                "Script %s exited with code %d (%.2fs): %s",
                cmd_str, result.returncode, duration, result.stderr[:200],
            )
        else:
            logger.debug("Script %s completed in %.2fs", cmd_str, duration)

        return result

    except asyncio.TimeoutError:
        duration = time.monotonic() - start
        logger.error("Script %s timed out after %ds", cmd_str, timeout)
        # Kill the process on timeout
        try:
            proc.kill()  # type: ignore[possibly-undefined]
            await proc.wait()
        except (ProcessLookupError, UnboundLocalError):
            pass
        return ScriptResult(
            returncode=-1,
            stdout="",
            stderr=f"Script timed out after {timeout}s",
            duration=duration,
            timed_out=True,
        )

    except FileNotFoundError:
        duration = time.monotonic() - start
        logger.error("Script not found: %s", script)
        return ScriptResult(
            returncode=-1,
            stdout="",
            stderr=f"Script not found: {script}",
            duration=duration,
        )

    except OSError as exc:
        duration = time.monotonic() - start
        logger.error("OS error running %s: %s", cmd_str, exc)
        return ScriptResult(
            returncode=-1,
            stdout="",
            stderr=str(exc),
            duration=duration,
        )
