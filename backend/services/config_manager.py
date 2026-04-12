"""Manager for teslausb_setup_variables.conf (bash env var format)."""

import logging
import re
import shutil
from datetime import datetime
from pathlib import Path

from backend.config import settings

logger = logging.getLogger(__name__)

# Matches: export VAR="value", VAR="value", VAR='value', VAR=value
_LINE_RE = re.compile(
    r'^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$'
)


def _unquote(value: str) -> str:
    """Remove surrounding quotes from a value, handling bash quoting styles."""
    value = value.strip()
    if len(value) >= 2:
        if (value.startswith('"') and value.endswith('"')) or \
           (value.startswith("'") and value.endswith("'")):
            return value[1:-1]
        # Handle $'...' ANSI-C quoting
        if value.startswith("$'") and value.endswith("'"):
            return value[2:-1]
    return value


def _quote(value: str) -> str:
    """Quote a value for bash assignment. Uses double quotes if needed."""
    if not value:
        return '""'
    # If the value contains spaces, special chars, or is empty, quote it
    if re.search(r'[\s"\'\\$`!#&|;(){}]', value):
        escaped = value.replace('\\', '\\\\').replace('"', '\\"').replace('$', '\\$')
        return f'"{escaped}"'
    return f'"{value}"'


def _config_path() -> Path:
    return Path(settings.teslausb_config_path)


def read_config() -> dict[str, str]:
    """Parse all variables from the config file.

    Returns:
        Dict mapping variable names to their unquoted values.
    """
    config: dict[str, str] = {}
    path = _config_path()

    if not path.exists():
        logger.warning("Config file not found: %s", path)
        return config

    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        match = _LINE_RE.match(stripped)
        if match:
            key, raw_value = match.group(1), match.group(2)
            config[key] = _unquote(raw_value)

    logger.debug("Read %d config variables from %s", len(config), path)
    return config


def get(key: str, default: str | None = None) -> str | None:
    """Get a single config value."""
    return read_config().get(key, default)


def write_config(updates: dict[str, str]) -> None:
    """Update specific variables in the config file.

    Preserves file format, comments, ordering, and existing quoting style.
    Creates a timestamped backup before writing.

    Args:
        updates: Dict of variable names to new values.
    """
    path = _config_path()
    if not path.exists():
        logger.error("Cannot write config: file not found at %s", path)
        raise FileNotFoundError(f"Config file not found: {path}")

    # Create backup
    backup_suffix = datetime.now().strftime("%Y%m%d")
    backup_path = path.with_suffix(f".conf.bak.{backup_suffix}")
    shutil.copy2(str(path), str(backup_path))
    logger.info("Config backup created: %s", backup_path)

    lines = path.read_text(encoding="utf-8").splitlines(keepends=True)
    remaining = dict(updates)
    new_lines: list[str] = []

    for line in lines:
        stripped = line.strip()
        match = _LINE_RE.match(stripped)
        if match and match.group(1) in remaining:
            key = match.group(1)
            new_value = remaining.pop(key)

            # Preserve 'export' prefix if original line had it
            prefix = "export " if stripped.startswith("export ") else ""
            quoted = _quote(new_value)
            # Preserve original line ending
            ending = line[len(line.rstrip()):] if line.rstrip() != line else "\n"
            new_lines.append(f"{prefix}{key}={quoted}{ending}")
            logger.debug("Updated %s=%s", key, new_value[:50])
        else:
            new_lines.append(line)

    # Append any variables that weren't already in the file
    if remaining:
        # Ensure we end with a newline before appending
        if new_lines and not new_lines[-1].endswith("\n"):
            new_lines[-1] += "\n"
        for key, value in remaining.items():
            new_lines.append(f"export {key}={_quote(value)}\n")
            logger.debug("Added new variable %s=%s", key, value[:50])

    path.write_text("".join(new_lines), encoding="utf-8")
    logger.info("Config updated: %d variables changed, %d added",
                len(updates) - len(remaining), len(remaining))
