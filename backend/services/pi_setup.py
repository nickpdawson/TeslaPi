"""Orchestrates TeslaPi hardware setup (drive partitioning, backing files, gadget config)."""

import asyncio
import json
import logging
import os
import signal
from datetime import datetime, timezone
from pathlib import Path

from backend.config import settings
from backend.services import config_manager

logger = logging.getLogger(__name__)


class PiSetup:
    """Orchestrates TeslaPi hardware setup.

    Manages the lifecycle of the setup-teslapi.sh script:
    starting, monitoring progress, reading logs, and cancellation.
    """

    SETUP_SCRIPT = "/opt/teslapi/deploy/setup-teslapi.sh"
    PROGRESS_FILE = Path("/tmp/teslapi-setup-progress.json")
    LOG_FILE = Path("/tmp/teslapi-setup.log")
    COMPLETION_FILE = Path("/mutable/teslapi/setup-complete.json")
    CONFIG_PATH = "/boot/firmware/teslausb_setup_variables.conf"

    STEP_NAMES = [
        "Source configuration",
        "Validate prerequisites",
        "Configure kernel modules",
        "Partition external drive",
        "Format and mount partitions",
        "Create backing file images",
        "Configure mount points",
        "Install gadget scripts",
        "Install archive loop",
        "Configure archive backend",
        "Check web service",
        "Write completion marker",
        "Summary",
    ]

    def __init__(self) -> None:
        self._process: asyncio.subprocess.Process | None = None
        self._running = False

    async def start_setup(self, config: dict) -> bool:
        """Start the setup process in the background.

        Writes config to teslausb_setup_variables.conf first,
        then launches setup-teslapi.sh as a background process.

        Args:
            config: Dict of configuration key/value pairs.

        Returns:
            True if setup was started successfully.
        """
        if self._running:
            logger.warning("Setup is already running (in-process flag)")
            return False

        # Check for an external setup process that might have been started outside this API
        if await self.is_running():
            logger.warning("Setup is already running (external process detected)")
            return False

        # Write config values before starting
        if config:
            try:
                config_manager.write_config(config)
                logger.info("Wrote %d config values before setup", len(config))
            except Exception as exc:
                if not settings.dev_mode:
                    logger.error("Failed to write config: %s", exc)
                    return False
                logger.info("Dev mode: config write failed (expected): %s", exc)

        if settings.dev_mode:
            logger.info("Dev mode: simulating setup start")
            self._running = True
            asyncio.create_task(self._simulate_setup())
            return True

        # Launch the setup script
        script = self.SETUP_SCRIPT
        if not os.path.isfile(script):
            logger.error("Setup script not found: %s", script)
            return False

        try:
            self._process = await asyncio.create_subprocess_exec(
                "sudo", script, "--config", self.CONFIG_PATH,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
            self._running = True
            asyncio.create_task(self._wait_for_completion())
            logger.info("Setup started (PID=%s)", self._process.pid)
            return True
        except Exception as exc:
            logger.error("Failed to start setup: %s", exc)
            return False

    async def _wait_for_completion(self) -> None:
        """Wait for the setup subprocess to finish."""
        if self._process is None:
            return
        try:
            await self._process.wait()
            rc = self._process.returncode
            if rc == 0:
                logger.info("Setup completed successfully")
            else:
                logger.error("Setup exited with code %d", rc)
        except Exception as exc:
            logger.error("Error waiting for setup: %s", exc)
        finally:
            self._running = False
            self._process = None

    async def _simulate_setup(self) -> None:
        """Simulate setup progress in dev mode."""
        progress_dir = self.PROGRESS_FILE.parent
        progress_dir.mkdir(parents=True, exist_ok=True)

        total = len(self.STEP_NAMES)
        for i, name in enumerate(self.STEP_NAMES, 1):
            if not self._running:
                break
            progress = {
                "step": i,
                "totalSteps": total,
                "currentAction": f"{name}...",
                "progress": 0.5,
                "overallProgress": round((i - 0.5) / total, 3),
                "error": None,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }
            self.PROGRESS_FILE.write_text(
                json.dumps(progress, indent=2), encoding="utf-8"
            )
            await asyncio.sleep(1.0)

        # Write final progress
        final = {
            "step": total,
            "totalSteps": total,
            "currentAction": "Setup complete!",
            "progress": 1,
            "overallProgress": 1.0,
            "error": None,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        self.PROGRESS_FILE.write_text(
            json.dumps(final, indent=2), encoding="utf-8"
        )

        # Write completion file
        completion = {
            "complete": True,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "version": "1.0.0",
            "dryRun": True,
        }
        self.COMPLETION_FILE.write_text(
            json.dumps(completion, indent=2), encoding="utf-8"
        )

        self._running = False
        logger.info("Dev mode: simulated setup complete")

    async def get_progress(self) -> dict:
        """Read current setup progress from the progress file.

        Returns:
            Dict with step, totalSteps, currentAction, progress,
            overallProgress, and error fields.
        """
        default = {
            "running": self._running,
            "step": 0,
            "totalSteps": len(self.STEP_NAMES),
            "currentAction": "Not started",
            "progress": 0,
            "overallProgress": 0,
            "error": None,
        }

        if settings.dev_mode and not self.PROGRESS_FILE.exists():
            return default

        try:
            if self.PROGRESS_FILE.exists():
                raw = self.PROGRESS_FILE.read_text(encoding="utf-8").strip()
                if not raw:
                    return default
                data = json.loads(raw)
                data["running"] = self._running

                # Add step name
                step = data.get("step", 0)
                if 1 <= step <= len(self.STEP_NAMES):
                    data["stepName"] = self.STEP_NAMES[step - 1]

                return data
        except json.JSONDecodeError as exc:
            # Progress file may be partially written; this is transient
            logger.debug("Progress file has invalid JSON (may be mid-write): %s", exc)
        except OSError as exc:
            logger.warning("Failed to read progress file: %s", exc)

        return default

    async def get_log(self, lines: int = 100) -> str:
        """Return the last N lines of the setup log.

        Args:
            lines: Number of lines to return.

        Returns:
            String with the last N log lines.
        """
        if settings.dev_mode and not self.LOG_FILE.exists():
            return "[dev mode] No setup log available yet."

        try:
            if self.LOG_FILE.exists():
                all_lines = self.LOG_FILE.read_text(encoding="utf-8").splitlines()
                return "\n".join(all_lines[-lines:])
        except OSError as exc:
            logger.warning("Failed to read log: %s", exc)

        return ""

    async def is_running(self) -> bool:
        """Check if setup is currently running."""
        if self._running:
            return True

        # Also check for an external process (e.g., started by a previous API instance)
        if not settings.dev_mode:
            try:
                result = await asyncio.create_subprocess_exec(
                    "pgrep", "-f", "setup-teslapi.sh",
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                stdout, _ = await result.communicate()
                if result.returncode == 0 and stdout.strip():
                    return True
            except Exception:
                pass

        return False

    async def cancel(self) -> bool:
        """Cancel a running setup (sends SIGTERM).

        Returns:
            True if a process was cancelled.
        """
        if self._process is not None:
            try:
                self._process.send_signal(signal.SIGTERM)
                self._running = False
                logger.info("Sent SIGTERM to setup process")
                return True
            except ProcessLookupError:
                self._running = False
                return False

        # Try to kill any externally-started process
        if not settings.dev_mode:
            try:
                result = await asyncio.create_subprocess_exec(
                    "sudo", "pkill", "-f", "setup-teslapi.sh",
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                await result.communicate()
                if result.returncode == 0:
                    self._running = False
                    return True
            except Exception:
                pass

        self._running = False
        return False

    async def is_complete(self) -> bool:
        """Check if setup has been completed successfully."""
        if settings.dev_mode:
            return self.COMPLETION_FILE.exists()

        try:
            if self.COMPLETION_FILE.exists():
                data = json.loads(
                    self.COMPLETION_FILE.read_text(encoding="utf-8")
                )
                return data.get("complete", False) is True
        except (json.JSONDecodeError, OSError):
            pass
        return False

    async def get_hardware_status(self) -> dict:
        """Check what hardware is configured.

        Returns a dict describing what's set up: drive partitioned,
        backing files exist, gadget configured, archive loop installed, etc.
        """
        status = {
            "driveDetected": False,
            "driveDevice": None,
            "driveSize": None,
            "drivePartitioned": False,
            "mutableMounted": False,
            "backingfilesMounted": False,
            "camImageExists": False,
            "musicImageExists": False,
            "lightshowImageExists": False,
            "boomboxImageExists": False,
            "gadgetConfigured": False,
            "gadgetKernelModule": False,
            "archiveLoopInstalled": False,
            "setupComplete": False,
        }

        if settings.dev_mode:
            # Return mock status in dev mode
            return {
                "driveDetected": True,
                "driveDevice": "/dev/sda",
                "driveSize": "500G",
                "drivePartitioned": False,
                "mutableMounted": False,
                "backingfilesMounted": False,
                "camImageExists": False,
                "musicImageExists": False,
                "lightshowImageExists": False,
                "boomboxImageExists": False,
                "gadgetConfigured": False,
                "gadgetKernelModule": True,
                "archiveLoopInstalled": False,
                "setupComplete": await self.is_complete(),
            }

        import subprocess

        # Check data drive
        try:
            try:
                conf = config_manager.read_config()
            except Exception:
                conf = {}
            data_drive = conf.get("DATA_DRIVE", "/dev/sda")
            result = subprocess.run(
                ["lsblk", "-b", "-d", "-n", "-o", "SIZE", data_drive],
                capture_output=True, text=True, timeout=5,
            )
            if result.returncode == 0 and result.stdout.strip():
                status["driveDetected"] = True
                status["driveDevice"] = data_drive
                size_bytes = int(result.stdout.strip())
                status["driveSize"] = f"{size_bytes // (1024**3)}G"
        except Exception as exc:
            logger.debug("Drive detection failed: %s", exc)

        # Check partitions
        try:
            result = subprocess.run(
                ["blkid", "-L", "mutable"],
                capture_output=True, text=True, timeout=5,
            )
            status["drivePartitioned"] = result.returncode == 0
        except Exception:
            pass

        # Check mounts
        try:
            result = subprocess.run(
                ["findmnt", "--mountpoint", "/mutable"],
                capture_output=True, text=True, timeout=5,
            )
            status["mutableMounted"] = result.returncode == 0
        except Exception:
            pass

        try:
            result = subprocess.run(
                ["findmnt", "--mountpoint", "/backingfiles"],
                capture_output=True, text=True, timeout=5,
            )
            status["backingfilesMounted"] = result.returncode == 0
        except Exception:
            pass

        # Check backing files
        status["camImageExists"] = os.path.isfile("/backingfiles/cam_disk.bin")
        status["musicImageExists"] = os.path.isfile("/backingfiles/music_disk.bin")
        status["lightshowImageExists"] = os.path.isfile(
            "/backingfiles/lightshow_disk.bin"
        )
        status["boomboxImageExists"] = os.path.isfile(
            "/backingfiles/boombox_disk.bin"
        )

        # Check gadget
        status["gadgetConfigured"] = os.path.isdir(
            "/sys/kernel/config/usb_gadget/teslapi"
        )
        try:
            result = subprocess.run(
                ["modinfo", "dwc2"],
                capture_output=True, text=True, timeout=5,
            )
            status["gadgetKernelModule"] = result.returncode == 0
        except Exception:
            pass

        # Check archive loop service
        try:
            result = subprocess.run(
                ["systemctl", "is-enabled", "teslausb.service"],
                capture_output=True, text=True, timeout=5,
            )
            status["archiveLoopInstalled"] = result.returncode == 0
        except Exception:
            pass

        # Setup completion
        status["setupComplete"] = await self.is_complete()

        return status


# Module-level singleton
pi_setup = PiSetup()
