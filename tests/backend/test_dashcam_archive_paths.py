"""Phase 2c (L1): lock the archive source/dest layout so it can't re-drift.

The old code pre-created ARCHIVE_MOUNT/TeslaCam/<event_type> in "Step 4" but the writer
copied to ARCHIVE_MOUNT/<event_type> at the share root — leaving stray empty dirs and a
confusing mismatch. Source reads from TeslaCam/<event_type>; dest writes to <event_type>.
"""
from backend.services import dashcam_archive as da


def test_clip_src_path_reads_from_teslacam_tree():
    p = da._clip_src_path("SavedClips", "2024-01-02_03-04-05", "front.mp4")
    assert p == f"{da.CAM_MOUNT}/TeslaCam/SavedClips/2024-01-02_03-04-05/front.mp4"


def test_clip_dest_dir_writes_to_share_root_without_teslacam():
    d = da._clip_dest_dir("SentryClips", "2024-01-02_03-04-05")
    assert d == f"{da.ARCHIVE_MOUNT}/SentryClips/2024-01-02_03-04-05"
    # the mismatch guard: dest must NOT carry the TeslaCam/ prefix the source uses
    assert "TeslaCam" not in d


def test_src_and_dest_share_event_type_and_dir():
    # same logical clip -> same event_type/event_dir tail on both sides
    src = da._clip_src_path("SavedClips", "evt", "f.mp4")
    dst = da._clip_dest_dir("SavedClips", "evt")
    assert src.endswith("SavedClips/evt/f.mp4")
    assert dst.endswith("SavedClips/evt")
