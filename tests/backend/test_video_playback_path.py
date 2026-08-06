"""Guard for archived-clip playback path resolution (H2)."""
import os
from pathlib import Path
from backend.routers.dashcam import _resolve_media_file


def _root(tmp_path):
    r = tmp_path / "archive"
    (r / "SavedClips" / "2026-04-10_14-19-54").mkdir(parents=True)
    (r / "SavedClips" / "2026-04-10_14-19-54" / "x-front.mp4").write_text("v")
    (tmp_path / "secret").mkdir()
    (tmp_path / "secret" / "passwd.mp4").write_text("nope")
    return r


def test_resolves_real_clip(tmp_path):
    r = _root(tmp_path)
    got = _resolve_media_file(r, "SavedClips/2026-04-10_14-19-54/x-front.mp4")
    assert got == (r / "SavedClips/2026-04-10_14-19-54/x-front.mp4").resolve()


def test_rejects_traversal_and_nonmp4(tmp_path):
    r = _root(tmp_path)
    assert _resolve_media_file(r, "../secret/passwd.mp4") is None      # escape
    assert _resolve_media_file(r, "SavedClips/../../secret/passwd.mp4") is None
    assert _resolve_media_file(r, "/etc/passwd") is None               # absolute
    assert _resolve_media_file(r, "SavedClips/2026-04-10_14-19-54") is None  # not .mp4
    # a non-existent but well-formed mp4 path resolves (caller checks is_file)
    assert _resolve_media_file(r, "SavedClips/nope/y-front.mp4") is not None
