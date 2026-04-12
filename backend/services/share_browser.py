"""Mount and browse CIFS/NFS shares."""

import logging
import os
import tempfile
from pathlib import Path

from backend.config import settings
from backend.services import script_runner

logger = logging.getLogger(__name__)

AUDIO_EXTENSIONS = frozenset({
    ".mp3", ".m4a", ".flac", ".ogg", ".wav", ".aac",
    ".wma", ".opus", ".aiff", ".alac",
})

# Dev mode mock data
_MOCK_ARTISTS = [
    "Radiohead", "Pink Floyd", "Led Zeppelin", "The Beatles", "Miles Davis",
    "John Coltrane", "Thelonious Monk", "Bill Evans", "Bob Dylan", "Neil Young",
    "Joni Mitchell", "Fleetwood Mac", "The Rolling Stones", "David Bowie",
    "Talking Heads", "Pixies", "Sonic Youth", "My Bloody Valentine", "Boards of Canada",
    "Aphex Twin", "Burial", "Four Tet", "Tycho", "Bonobo", "Khruangbin",
]

_MOCK_ALBUMS = {
    "Radiohead": ["OK Computer", "Kid A", "In Rainbows", "A Moon Shaped Pool"],
    "Pink Floyd": ["The Dark Side of the Moon", "Wish You Were Here", "Animals", "The Wall"],
    "Led Zeppelin": ["Led Zeppelin IV", "Physical Graffiti", "Houses of the Holy"],
    "The Beatles": ["Abbey Road", "Revolver", "Sgt. Pepper's"],
    "Miles Davis": ["Kind of Blue", "Bitches Brew", "In a Silent Way"],
    "John Coltrane": ["A Love Supreme", "Blue Train", "My Favorite Things"],
}


def _validate_path(mountpoint: str, path: str) -> Path:
    """Validate that path doesn't escape mountpoint. Returns resolved Path."""
    mount = Path(mountpoint).resolve()
    target = (mount / path.lstrip("/")).resolve()
    if not str(target).startswith(str(mount)):
        raise ValueError(f"Path escapes mountpoint: {path}")
    return target


async def mount_share(
    share_type: str,
    server: str,
    path: str,
    mountpoint: str,
    username: str = "",
    password: str = "",
    domain: str = "",
    mount_options: str = "",
    read_only: bool = True,
) -> bool:
    """Mount a CIFS or NFS share.

    Args:
        read_only: If True, mount read-only (default). If False, mount read-write.

    Returns True on success.
    """
    if settings.dev_mode:
        logger.info("Dev mode: simulating mount of %s:%s at %s", server, path, mountpoint)
        return True

    os.makedirs(mountpoint, exist_ok=True)

    if share_type == "cifs":
        # Write credentials to a temp file
        cred_file = None
        try:
            if username:
                cred_file = tempfile.NamedTemporaryFile(
                    mode="w", suffix=".cifs-cred", delete=False
                )
                cred_file.write(f"username={username}\n")
                cred_file.write(f"password={password}\n")
                if domain:
                    cred_file.write(f"domain={domain}\n")
                cred_file.close()
                os.chmod(cred_file.name, 0o600)

            rw_flag = "ro" if read_only else "rw"
            opts = f"{rw_flag},iocharset=utf8,file_mode=0777,dir_mode=0777,vers=default"
            if cred_file:
                opts += f",credentials={cred_file.name}"
            else:
                opts += ",guest"
            if mount_options:
                opts += f",{mount_options}"

            source = f"//{server}/{path.lstrip('/')}"
            logger.info("CIFS mount: %s -> %s opts=%s (has_creds=%s, user=%s, domain=%s)",
                        source, mountpoint, opts, cred_file is not None, username or "none", domain or "none")
            result = await script_runner.run(
                "/sbin/mount.cifs", [source, mountpoint, "-o", opts], timeout=30,
            )

            if result.returncode != 0:
                logger.error("CIFS mount failed (exit %d): stdout=%s stderr=%s",
                             result.returncode, result.stdout, result.stderr)
                return False
            logger.info("CIFS mount succeeded: %s", source)
            return True
        finally:
            if cred_file and os.path.exists(cred_file.name):
                os.unlink(cred_file.name)

    elif share_type == "nfs":
        rw_flag = "ro" if read_only else "rw"
        opts = f"{rw_flag},noexec,nosuid"
        if mount_options:
            opts += f",{mount_options}"

        source = f"{server}:{path}"
        result = await script_runner.run(
            "mount.nfs", [source, mountpoint, "-o", opts], timeout=30,
        )

        if result.returncode != 0:
            logger.error("NFS mount failed: %s", result.stderr)
            return False
        return True

    else:
        raise ValueError(f"Unsupported share type: {share_type}")


async def unmount_share(mountpoint: str) -> bool:
    """Unmount a share. Returns True on success."""
    if settings.dev_mode:
        logger.info("Dev mode: simulating unmount of %s", mountpoint)
        return True

    result = await script_runner.run("umount", [mountpoint], timeout=15)
    if result.returncode != 0:
        logger.warning("Unmount failed for %s: %s", mountpoint, result.stderr)
        # Try lazy unmount
        result = await script_runner.run("umount", ["-l", mountpoint], timeout=15)
        return result.returncode == 0
    return True


async def is_mounted(mountpoint: str) -> bool:
    """Check if a path is a mount point."""
    if settings.dev_mode:
        return True

    result = await script_runner.run("mountpoint", ["-q", mountpoint], timeout=5)
    return result.returncode == 0


def browse(mountpoint: str, path: str = "/") -> list[dict]:
    """List directory contents at mountpoint/path.

    Returns list of dicts with: name, path, isDirectory, size, modified, type.
    """
    if settings.dev_mode:
        return _browse_mock(path)

    target = _validate_path(mountpoint, path)

    if not target.is_dir():
        raise FileNotFoundError(f"Not a directory: {path}")

    entries = []
    try:
        for entry in sorted(target.iterdir(), key=lambda e: (not e.is_dir(), e.name.lower())):
            # Skip hidden files
            if entry.name.startswith("."):
                continue
            stat = entry.stat()
            rel_path = str(entry.relative_to(Path(mountpoint).resolve()))
            entries.append({
                "name": entry.name,
                "path": "/" + rel_path,
                "isDirectory": entry.is_dir(),
                "size": stat.st_size if not entry.is_dir() else 0,
                "modified": stat.st_mtime,
                "type": _guess_type(entry.name) if not entry.is_dir() else "directory",
            })
    except PermissionError as exc:
        logger.warning("Permission denied browsing %s: %s", target, exc)
        raise

    return entries


def _guess_type(filename: str) -> str:
    """Return a simple type string based on extension."""
    ext = Path(filename).suffix.lower()
    if ext in AUDIO_EXTENSIONS:
        return "audio"
    return "file"


def browse_paginated(mountpoint: str, path: str = "/", offset: int = 0, limit: int = 200, name_filter: str = "") -> dict:
    """List directory contents with pagination and optional name filter.

    Uses os.scandir for fast listing without stat() on every entry.
    Returns dict with: items, total, offset, limit, hasMore.
    """
    if settings.dev_mode:
        all_entries = _browse_mock(path)
        if name_filter:
            lf = name_filter.lower()
            all_entries = [e for e in all_entries if lf in e["name"].lower()]
        total = len(all_entries)
        page = all_entries[offset : offset + limit]
        return {"items": page, "total": total, "offset": offset, "limit": limit, "hasMore": offset + limit < total, "path": path}

    target = _validate_path(mountpoint, path)
    if not target.is_dir():
        raise FileNotFoundError(f"Not a directory: {path}")

    # Use scandir for fast listing (no stat per entry)
    lf = name_filter.lower() if name_filter else ""
    entries = []
    try:
        for entry in sorted(os.scandir(target), key=lambda e: (not e.is_dir(follow_symlinks=False), e.name.lower())):
            if entry.name.startswith("."):
                continue
            if lf and lf not in entry.name.lower():
                continue
            entries.append(entry)
    except PermissionError:
        raise

    total = len(entries)
    page_entries = entries[offset : offset + limit]

    items = []
    for entry in page_entries:
        is_dir = entry.is_dir(follow_symlinks=False)
        try:
            size = 0 if is_dir else entry.stat(follow_symlinks=False).st_size
        except OSError:
            size = 0

        rel_path = os.path.relpath(entry.path, mountpoint)
        items.append({
            "name": entry.name,
            "path": "/" + rel_path,
            "isDirectory": is_dir,
            "size": size,
        })

    return {
        "items": items,
        "total": total,
        "offset": offset,
        "limit": limit,
        "hasMore": offset + limit < total,
        "path": path,
    }


def get_music_share_config() -> dict | None:
    """Read music share config from teslausb_setup_variables.conf.

    Looks for music_share_* keys or MUSIC_SHARE_NAME + ARCHIVE_SERVER.
    Returns dict with: server, share_name, share_type, username, password, domain.
    """
    from backend.services.config_manager import read_config

    cfg = read_config()
    if not cfg:
        return None

    # Try music_share_* keys first
    server = cfg.get("music_share_server") or cfg.get("ARCHIVE_SERVER", "")
    share_name = cfg.get("music_share_name") or cfg.get("MUSIC_SHARE_NAME", "")
    share_type = cfg.get("music_share_type", "cifs")
    username = cfg.get("music_share_user") or cfg.get("SHARE_USER", "")
    password = cfg.get("music_share_pass") or cfg.get("SHARE_PASSWORD", "")
    domain = cfg.get("music_share_domain") or cfg.get("SHARE_DOMAIN", "")

    if not server or not share_name:
        return None

    return {
        "server": server,
        "share_name": share_name,
        "share_type": share_type,
        "username": username,
        "password": password,
        "domain": domain,
    }


def _browse_mock(path: str) -> list[dict]:
    """Return mock directory listing simulating a music library."""
    parts = path.strip("/").split("/") if path.strip("/") else []
    entries = []

    if len(parts) == 0:
        # Root: list artists
        for artist in _MOCK_ARTISTS:
            entries.append({
                "name": artist,
                "path": f"/{artist}",
                "isDirectory": True,
                "size": 0,
                "modified": 1700000000,
                "type": "directory",
            })
    elif len(parts) == 1:
        # Artist: list albums
        artist = parts[0]
        albums = _MOCK_ALBUMS.get(artist, [f"Album {i}" for i in range(1, 5)])
        for album in albums:
            entries.append({
                "name": album,
                "path": f"/{artist}/{album}",
                "isDirectory": True,
                "size": 0,
                "modified": 1700000000,
                "type": "directory",
            })
    elif len(parts) == 2:
        # Album: list tracks
        for i in range(1, 13):
            name = f"{i:02d} Track {i}.flac"
            entries.append({
                "name": name,
                "path": f"/{parts[0]}/{parts[1]}/{name}",
                "isDirectory": False,
                "size": 35_000_000 + (i * 2_000_000),
                "modified": 1700000000,
                "type": "audio",
            })

    return entries
