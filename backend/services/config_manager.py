"""Manager for teslausb_setup_variables.conf (bash env var format)."""

import logging
import re
import shlex
import shutil
from datetime import datetime
from pathlib import Path

from backend.config import settings

logger = logging.getLogger(__name__)

# Matches: export VAR="value", VAR="value", VAR='value', VAR=value
_LINE_RE = re.compile(
    r'^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$'
)

# A valid bash variable name — enforced on write so a key can't smuggle in a
# newline or shell metacharacters (this file is `source`d by root).
_KEY_RE = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*$')

# Canonical definition (imported by routers/config.py and routers/setup.py so all
# three agree). Keys whose values are secrets and must be masked in API responses.
# Uses precise terms — `wifipass`/`_pass` catch teslausb's WIFIPASS / WIFI_PASS /
# SHARE_PASSWORD without matching innocent substrings like COMPASS or BYPASS.
SENSITIVE_KEY_RE = re.compile(
    r'(password|passwd|wifipass|_pass|secret|token|key|credential)', re.IGNORECASE
)
MASK = "********"


def is_sensitive_key(key: str) -> bool:
    return SENSITIVE_KEY_RE.search(key) is not None


def _unquote(value: str) -> str:
    """Reverse _quote — parse a bash-quoted value back to its literal string.

    Uses shlex (the counterpart to shlex.quote) so it correctly handles the
    ``'it'"'"'s'`` form single-quoting produces for embedded apostrophes, as well
    as legacy double-quoted values written by earlier versions.
    """
    value = value.strip()
    # ANSI-C $'...' — shlex doesn't apply bash's escape semantics; strip literally.
    if value.startswith("$'") and value.endswith("'") and len(value) >= 3:
        return value[2:-1]
    try:
        parts = shlex.split(value)
        if len(parts) == 1:
            return parts[0]
    except ValueError:
        pass
    # Fallback: strip a single matching quote pair.
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    return value


def _quote(value: str) -> str:
    """Quote a value for a bash assignment that root will `source`.

    Uses shlex.quote (single-quoting), the standard proven primitive, instead of
    hand-rolled double-quote escaping — the old version escaped $, \\, and " but
    NOT backticks, so a value like ``\\`reboot\\``` executed as a command when the
    file was sourced. shlex.quote neutralizes $, backticks, quotes, and every other
    metacharacter at once.
    """
    if not value:
        return "''"
    return shlex.quote(value)


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
    # Drop unchanged masked secrets: a SENSITIVE key whose value is exactly the mask
    # means the client received it masked and echoed it back — writing it would
    # overwrite the real secret (e.g. WIFIPASS) with "********". Treat as "keep
    # existing". Scoped to sensitive keys so a non-secret value that happens to be
    # "********" still writes through. (A secret set to literally 8 asterisks is
    # indistinguishable from the masked echo and is treated as unchanged — the
    # complete fix is the Phase 4 frontend contract that omits unchanged secrets.)
    dropped = [k for k, v in updates.items() if v == MASK and is_sensitive_key(k)]
    if dropped:
        logger.debug("Ignoring masked (unchanged) secret values for: %s", ", ".join(dropped))
        updates = {k: v for k, v in updates.items() if not (v == MASK and is_sensitive_key(k))}

    if not updates:
        logger.info("Config write skipped: no changed values")
        return

    # Validate before touching the file: reject keys that aren't plain bash
    # identifiers and values containing control characters (newlines etc.), which
    # the line-based format can't round-trip and which could inject extra lines.
    for key, value in updates.items():
        if not _KEY_RE.match(key):
            raise ValueError(f"Invalid config key: {key!r}")
        if any(ord(c) < 0x20 or ord(c) == 0x7f for c in value):
            raise ValueError(f"Config value for {key!r} contains control characters")

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
