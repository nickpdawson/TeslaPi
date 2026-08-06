"""Security guard for the local-music delete path (fable C3).

_safe_delete_target must refuse any path that resolves outside the music-image mount
(../, absolute paths, escaping symlinks) and refuse the mount root itself — otherwise
a delete could rmtree the NAS source share.
"""
import os
from backend.routers.music import _safe_delete_target


def _mount(tmp_path):
    m = tmp_path / "mnt_music"
    (m / "Music" / "Artist").mkdir(parents=True)
    (m / "Music" / "Artist" / "track.mp3").write_text("x")
    # a sibling that MUST NOT be reachable (simulates /mnt/music_share next to /mnt/music)
    (tmp_path / "mnt_music_share").mkdir()
    (tmp_path / "mnt_music_share" / "precious.flac").write_text("nas")
    return str(m)


def test_allows_real_subpath(tmp_path):
    m = _mount(tmp_path)
    t = _safe_delete_target(m, "Music/Artist")
    assert t == os.path.realpath(os.path.join(m, "Music/Artist"))
    assert _safe_delete_target(m, "Music/Artist/track.mp3") is not None


def test_refuses_root(tmp_path):
    m = _mount(tmp_path)
    assert _safe_delete_target(m, "") is None
    assert _safe_delete_target(m, ".") is None


def test_refuses_parent_traversal(tmp_path):
    m = _mount(tmp_path)
    assert _safe_delete_target(m, "..") is None
    assert _safe_delete_target(m, "../mnt_music_share") is None            # sibling NAS mount
    assert _safe_delete_target(m, "../mnt_music_share/precious.flac") is None
    assert _safe_delete_target(m, "Music/../../mnt_music_share") is None


def test_refuses_absolute_path(tmp_path):
    m = _mount(tmp_path)
    # os.path.join(mount, "/etc/passwd") == "/etc/passwd" -> must be rejected
    assert _safe_delete_target(m, "/etc/passwd") is None


def test_refuses_escaping_symlink(tmp_path):
    m = _mount(tmp_path)
    # symlink inside the mount that points at the sibling NAS mount
    link = os.path.join(m, "Music", "escape")
    os.symlink(str(tmp_path / "mnt_music_share"), link)
    assert _safe_delete_target(m, "Music/escape") is None
    assert _safe_delete_target(m, "Music/escape/precious.flac") is None
