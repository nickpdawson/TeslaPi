"""TeslaPi OTA update service.

Manages checking for updates, downloading, applying, and rolling back
software updates.  Works with the read-only rootfs by remounting rw
only during writes and restoring ro afterward.

In dev mode every operation returns mock data and simulates delays so
the frontend can be developed without a real Pi.
"""

import asyncio
import json
import logging
import os
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx

from backend.config import settings
from backend.services import script_runner

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Data classes (plain dicts would work, but these keep the API surface tidy)
# ---------------------------------------------------------------------------

class Updater:
    """Manages TeslaPi software updates."""

    GITHUB_REPO = "nickpdawson/TeslaPi"
    CURRENT_VERSION_FILE = "/opt/teslapi/VERSION"
    BACKUP_DIR = "/mutable/teslapi/rollback"
    UPDATE_DIR = "/tmp/teslapi-update"
    HISTORY_FILE = "/mutable/teslapi/update-history.json"
    AUTO_UPDATE_FILE = "/mutable/teslapi/auto-update.json"

    # Paths that get backed up / restored during rollback
    INSTALL_PATHS = {
        "backend": "/opt/teslapi/backend",
        "frontend": "/var/www/teslapi",
        "version": "/opt/teslapi/VERSION",
    }

    def __init__(self) -> None:
        self._status: dict = {
            "in_progress": False,
            "stage": None,
            "progress": 0.0,
            "message": None,
        }
        self._lock = asyncio.Lock()

    # ------------------------------------------------------------------
    # Status helpers
    # ------------------------------------------------------------------

    def _set_status(
        self,
        in_progress: bool,
        stage: str | None = None,
        progress: float = 0.0,
        message: str | None = None,
    ) -> None:
        self._status = {
            "in_progress": in_progress,
            "stage": stage,
            "progress": progress,
            "message": message,
        }

    def get_status(self) -> dict:
        return dict(self._status)

    # ------------------------------------------------------------------
    # Version helpers
    # ------------------------------------------------------------------

    async def get_current_version(self) -> str:
        """Read the installed version string from the VERSION file."""
        if settings.dev_mode:
            return "1.0.0"

        try:
            path = Path(self.CURRENT_VERSION_FILE)
            if path.exists():
                text = path.read_text().strip()
                # VERSION file may have version on first line, commit hash on second
                return text.splitlines()[0]
        except Exception as exc:
            logger.warning("Could not read VERSION file: %s", exc)
        return "0.0.0"

    @staticmethod
    def _parse_semver(version: str) -> tuple[int, ...]:
        """Parse a semver string like '1.2.3' into a comparable tuple."""
        # Strip leading 'v' if present
        version = version.lstrip("vV").strip()
        parts = []
        for part in version.split(".")[:3]:
            # Handle pre-release suffixes like 1.0.0-beta by taking only digits
            digits = ""
            for ch in part:
                if ch.isdigit():
                    digits += ch
                else:
                    break
            parts.append(int(digits) if digits else 0)
        while len(parts) < 3:
            parts.append(0)
        return tuple(parts)

    # ------------------------------------------------------------------
    # Check for updates
    # ------------------------------------------------------------------

    async def check_for_updates(self) -> dict:
        """Check GitHub releases API for a newer version.

        Returns a dict matching the UpdateInfo schema.
        """
        current = await self.get_current_version()

        if settings.dev_mode:
            return {
                "available": True,
                "current_version": current,
                "latest_version": "1.1.0",
                "changelog": (
                    "## What's New in v1.1.0\n\n"
                    "- OTA update system with rollback support\n"
                    "- Improved dashcam event viewer performance\n"
                    "- Fixed WiFi reconnection after sleep\n"
                    "- Updated dependencies"
                ),
                "download_url": "https://github.com/nickpdawson/TeslaPi/releases/download/v1.1.0/teslapi.tar.gz",
                "published_at": "2026-04-08T12:00:00Z",
                "size_bytes": 4_500_000,
            }

        url = f"https://api.github.com/repos/{self.GITHUB_REPO}/releases/latest"
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.get(url, headers={"Accept": "application/vnd.github+json"})
                resp.raise_for_status()
                data = resp.json()
        except Exception as exc:
            logger.error("GitHub release check failed: %s", exc)
            return {
                "available": False,
                "current_version": current,
                "latest_version": None,
                "changelog": None,
                "download_url": None,
                "published_at": None,
                "size_bytes": None,
            }

        latest_tag = data.get("tag_name", "0.0.0")
        latest_parsed = self._parse_semver(latest_tag)
        current_parsed = self._parse_semver(current)

        # Find the tarball asset
        download_url: str | None = None
        size_bytes: int | None = None
        for asset in data.get("assets", []):
            name = asset.get("name", "")
            if name.endswith(".tar.gz") or name.endswith(".tgz"):
                download_url = asset.get("browser_download_url")
                size_bytes = asset.get("size")
                break

        return {
            "available": latest_parsed > current_parsed,
            "current_version": current,
            "latest_version": latest_tag,
            "changelog": data.get("body"),
            "download_url": download_url,
            "published_at": data.get("published_at"),
            "size_bytes": size_bytes,
        }

    # ------------------------------------------------------------------
    # Download
    # ------------------------------------------------------------------

    async def download_update(self, url: str, version: str) -> str:
        """Download a release tarball to a temporary directory.

        Returns the path to the downloaded file.
        """
        if settings.dev_mode:
            # Simulate download with progress
            for pct in (0.1, 0.3, 0.5, 0.7, 0.9, 1.0):
                self._set_status(True, "downloading", pct, f"Downloading v{version}...")
                await asyncio.sleep(0.4)
            fake_path = os.path.join(self.UPDATE_DIR, "teslapi.tar.gz")
            os.makedirs(self.UPDATE_DIR, exist_ok=True)
            Path(fake_path).write_text("mock-tarball")
            return fake_path

        os.makedirs(self.UPDATE_DIR, exist_ok=True)
        dest = os.path.join(self.UPDATE_DIR, f"teslapi-{version}.tar.gz")

        try:
            async with httpx.AsyncClient(timeout=300, follow_redirects=True) as client:
                async with client.stream("GET", url) as resp:
                    resp.raise_for_status()
                    total = int(resp.headers.get("content-length", 0))
                    downloaded = 0
                    with open(dest, "wb") as fh:
                        async for chunk in resp.aiter_bytes(chunk_size=65536):
                            fh.write(chunk)
                            downloaded += len(chunk)
                            if total > 0:
                                pct = downloaded / total
                            else:
                                pct = 0.0
                            self._set_status(
                                True, "downloading", pct,
                                f"Downloading v{version}... ({downloaded // 1024}KB)",
                            )
        except Exception as exc:
            logger.error("Download failed: %s", exc)
            raise RuntimeError(f"Failed to download update: {exc}") from exc

        # Verify file was written
        if not os.path.isfile(dest) or os.path.getsize(dest) == 0:
            raise RuntimeError("Downloaded file is empty or missing")

        return dest

    # ------------------------------------------------------------------
    # Backup / Rollback
    # ------------------------------------------------------------------

    async def create_backup(self) -> str:
        """Backup the current installation to the rollback directory.

        Returns the backup directory path.
        """
        self._set_status(True, "backing_up", 0.0, "Backing up current installation...")

        if settings.dev_mode:
            await asyncio.sleep(0.5)
            self._set_status(True, "backing_up", 1.0, "Backup complete")
            return self.BACKUP_DIR

        backup = self.BACKUP_DIR
        # Wipe previous backup
        if os.path.exists(backup):
            shutil.rmtree(backup)
        os.makedirs(backup, exist_ok=True)

        # Copy each install path
        for label, src in self.INSTALL_PATHS.items():
            dst = os.path.join(backup, label)
            if os.path.isdir(src):
                shutil.copytree(src, dst)
            elif os.path.isfile(src):
                shutil.copy2(src, dst)
            else:
                logger.warning("Backup: source %s does not exist, skipping", src)

        self._set_status(True, "backing_up", 1.0, "Backup complete")
        return backup

    async def rollback(self) -> bool:
        """Restore the backed-up version.

        Returns True on success.
        """
        if settings.dev_mode:
            self._set_status(True, "rolling_back", 0.5, "Rolling back (dev mode)...")
            await asyncio.sleep(1)
            self._set_status(False, None, 0, "Rollback simulated")
            return True

        backup = self.BACKUP_DIR
        if not os.path.isdir(backup):
            logger.error("No rollback backup found at %s", backup)
            return False

        try:
            # Remount rw
            await self._remount_rw()

            # Restore each path
            for label, dst in self.INSTALL_PATHS.items():
                src = os.path.join(backup, label)
                if not os.path.exists(src):
                    continue
                if os.path.isdir(dst):
                    shutil.rmtree(dst)
                elif os.path.isfile(dst):
                    os.remove(dst)
                if os.path.isdir(src):
                    shutil.copytree(src, dst)
                else:
                    shutil.copy2(src, dst)

            # Remount ro
            await self._remount_ro()

            # Restart service
            await script_runner.run("sudo", ["systemctl", "restart", "teslapi"], timeout=30)
            return True

        except Exception as exc:
            logger.error("Rollback failed: %s", exc)
            # Best effort to remount ro
            await self._remount_ro()
            return False

    # ------------------------------------------------------------------
    # Apply update
    # ------------------------------------------------------------------

    async def apply_update(self, tarball_path: str) -> dict:
        """Apply an update from a tarball.

        Returns an UpdateResult dict.
        """
        async with self._lock:
            return await self._apply_update_inner(tarball_path)

    async def _apply_update_inner(self, tarball_path: str) -> dict:
        from_version = await self.get_current_version()
        to_version = "unknown"
        start = time.monotonic()

        try:
            # --- 1. Create backup ---
            await self.create_backup()

            if settings.dev_mode:
                # Simulate install stages
                for stage, pct, msg, delay in [
                    ("installing", 0.2, "Extracting update...", 0.5),
                    ("installing", 0.5, "Running installer...", 1.0),
                    ("restarting", 0.7, "Restarting services...", 0.8),
                    ("verifying", 0.9, "Verifying health...", 0.5),
                ]:
                    self._set_status(True, stage, pct, msg)
                    await asyncio.sleep(delay)

                to_version = "1.1.0"
                result = {
                    "success": True,
                    "from_version": from_version,
                    "to_version": to_version,
                    "message": "Update applied successfully (dev mode)",
                    "rolled_back": False,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                }
                await self._record_history(result, method="github")
                self._set_status(False, None, 1.0, "Update complete!")
                return result

            # --- 2. Extract tarball ---
            self._set_status(True, "installing", 0.2, "Extracting update...")
            extract_dir = os.path.join(self.UPDATE_DIR, "extract")
            if os.path.exists(extract_dir):
                shutil.rmtree(extract_dir)
            os.makedirs(extract_dir, exist_ok=True)

            res = await script_runner.run(
                "tar", ["xzf", tarball_path, "-C", extract_dir],
                timeout=120,
            )
            if res.returncode != 0:
                raise RuntimeError(f"Tarball extraction failed: {res.stderr}")

            # Find install.sh inside the extracted directory
            install_sh = self._find_install_sh(extract_dir)
            if not install_sh:
                raise RuntimeError("install.sh not found in update package")

            # Read new version from package
            pkg_dir = os.path.dirname(install_sh)
            version_file = os.path.join(pkg_dir, "VERSION")
            if os.path.isfile(version_file):
                to_version = Path(version_file).read_text().strip().splitlines()[0]

            # --- 3. Run installer (handles remount rw/ro internally) ---
            self._set_status(True, "installing", 0.5, f"Installing v{to_version}...")
            res = await script_runner.run(
                "sudo", ["bash", install_sh],
                timeout=300,
                cwd=pkg_dir,
            )
            if res.returncode != 0:
                raise RuntimeError(f"Installer failed (exit {res.returncode}): {res.stderr}")

            # --- 4. Restart services ---
            self._set_status(True, "restarting", 0.7, "Restarting services...")
            await script_runner.run("sudo", ["systemctl", "restart", "teslapi"], timeout=30)
            await asyncio.sleep(3)  # Give the service a moment to start

            # --- 5. Health check ---
            self._set_status(True, "verifying", 0.9, "Verifying health...")
            healthy = await self._health_check()

            if not healthy:
                # Trigger rollback
                self._set_status(True, "rolling_back", 0.95, "Health check failed, rolling back...")
                rolled_back = await self.rollback()
                result = {
                    "success": False,
                    "from_version": from_version,
                    "to_version": to_version,
                    "message": f"Update to {to_version} failed health check. "
                               + ("Rolled back successfully." if rolled_back else "Rollback also failed!"),
                    "rolled_back": rolled_back,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                }
                await self._record_history(result, method="github")
                self._set_status(False, None, 0, result["message"])
                return result

            # Success
            result = {
                "success": True,
                "from_version": from_version,
                "to_version": to_version,
                "message": f"Successfully updated from {from_version} to {to_version}",
                "rolled_back": False,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }
            await self._record_history(result, method="github")
            self._set_status(False, None, 1.0, "Update complete!")
            return result

        except Exception as exc:
            logger.error("Update failed: %s", exc)
            # Attempt rollback
            self._set_status(True, "rolling_back", 0.95, f"Update failed: {exc} — rolling back...")
            rolled_back = False
            if not settings.dev_mode:
                rolled_back = await self.rollback()

            result = {
                "success": False,
                "from_version": from_version,
                "to_version": to_version,
                "message": str(exc),
                "rolled_back": rolled_back,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }
            await self._record_history(result, method="github")
            self._set_status(False, None, 0, str(exc))
            return result

        finally:
            # Clean up temp files
            try:
                if os.path.exists(self.UPDATE_DIR):
                    shutil.rmtree(self.UPDATE_DIR)
            except Exception:
                pass

    async def apply_uploaded_update(self, file_content: bytes, filename: str) -> dict:
        """Apply an update from user-uploaded tarball bytes."""
        os.makedirs(self.UPDATE_DIR, exist_ok=True)
        dest = os.path.join(self.UPDATE_DIR, filename)
        with open(dest, "wb") as fh:
            fh.write(file_content)

        result = await self.apply_update(dest)
        # Override method in history
        history = await self.get_update_history()
        if history:
            history[-1]["method"] = "upload"
            await self._write_history(history)
        return result

    # ------------------------------------------------------------------
    # Download-and-apply combo
    # ------------------------------------------------------------------

    async def download_and_apply(self) -> dict:
        """Check for update, download it, and apply it."""
        info = await self.check_for_updates()
        if not info["available"] or not info.get("download_url"):
            return {
                "success": False,
                "from_version": info["current_version"],
                "to_version": info.get("latest_version", "unknown"),
                "message": "No update available" if not info["available"] else "No download URL found",
                "rolled_back": False,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }

        tarball = await self.download_update(info["download_url"], info["latest_version"])
        return await self.apply_update(tarball)

    # ------------------------------------------------------------------
    # History
    # ------------------------------------------------------------------

    async def get_update_history(self) -> list[dict]:
        """Return the list of past update records."""
        if settings.dev_mode:
            return [
                {
                    "version": "1.0.0",
                    "from_version": "0.9.0",
                    "timestamp": "2026-04-01T10:00:00Z",
                    "success": True,
                    "method": "github",
                    "message": "Updated from 0.9.0 to 1.0.0",
                },
            ]
        try:
            path = Path(self.HISTORY_FILE)
            if path.exists():
                return json.loads(path.read_text())
        except Exception as exc:
            logger.warning("Could not read update history: %s", exc)
        return []

    async def _write_history(self, records: list[dict]) -> None:
        try:
            path = Path(self.HISTORY_FILE)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(records, indent=2))
        except Exception as exc:
            logger.warning("Could not write update history: %s", exc)

    async def _record_history(self, result: dict, method: str) -> None:
        records = await self.get_update_history()
        records.append({
            "version": result["to_version"],
            "from_version": result["from_version"],
            "timestamp": result["timestamp"],
            "success": result["success"],
            "method": method,
            "message": result["message"],
        })
        # Keep last 50 entries
        records = records[-50:]
        await self._write_history(records)

    # ------------------------------------------------------------------
    # Auto-update config
    # ------------------------------------------------------------------

    async def get_auto_update_config(self) -> dict:
        if settings.dev_mode:
            return {"enabled": False, "interval_hours": 24, "last_check": None}
        try:
            path = Path(self.AUTO_UPDATE_FILE)
            if path.exists():
                return json.loads(path.read_text())
        except Exception as exc:
            logger.warning("Could not read auto-update config: %s", exc)
        return {"enabled": False, "interval_hours": 24, "last_check": None}

    async def set_auto_update_config(self, enabled: bool, interval_hours: int) -> dict:
        config = {
            "enabled": enabled,
            "interval_hours": interval_hours,
            "last_check": None,
        }
        if not settings.dev_mode:
            try:
                path = Path(self.AUTO_UPDATE_FILE)
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps(config, indent=2))
            except Exception as exc:
                logger.warning("Could not write auto-update config: %s", exc)
        return config

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _find_install_sh(extract_dir: str) -> str | None:
        """Locate install.sh inside an extracted tarball directory."""
        for root, _dirs, files in os.walk(extract_dir):
            if "install.sh" in files:
                return os.path.join(root, "install.sh")
        return None

    @staticmethod
    async def _remount_rw() -> None:
        res = await script_runner.run("sudo", ["mount", "-o", "remount,rw", "/"], timeout=10)
        if res.returncode != 0:
            raise RuntimeError(f"Failed to remount rootfs rw: {res.stderr}")

    @staticmethod
    async def _remount_ro() -> None:
        res = await script_runner.run("sudo", ["mount", "-o", "remount,ro", "/"], timeout=10)
        if res.returncode != 0:
            logger.warning("Could not remount rootfs ro: %s", res.stderr)

    @staticmethod
    async def _health_check(retries: int = 10, delay: float = 1.0) -> bool:
        """Ping the local /api/health endpoint to verify the service is alive."""
        for attempt in range(retries):
            try:
                async with httpx.AsyncClient(timeout=5) as client:
                    resp = await client.get("http://127.0.0.1:8080/api/health")
                    if resp.status_code == 200:
                        return True
            except Exception:
                pass
            await asyncio.sleep(delay)
        return False


# Module-level singleton
updater = Updater()
