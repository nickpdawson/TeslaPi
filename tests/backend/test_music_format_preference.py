"""MUSIC_PREFER_AAC: copy a FLAC only when the source has no M4A/AAC of the same track.

Ported from the old teslausb-musicsync script, minus its two bugs:
  * it used --delete-excluded on the M4A pass, which deleted every FLAC on the drive
    each run (the FLAC pass then re-copied them);
  * it used --ignore-existing on the FLAC pass, which compares destination names, so
    a FLAC was copied next to an M4A of the same track.
Here the twin check runs against the SOURCE, and no rsync call ever deletes. The
option defaults to off. rsync and the gadget lifecycle are stubbed except in the one
test that runs a real rsync against temp dirs to prove the exclude file is right.
"""
import asyncio
import os
import shutil
import sqlite3
import subprocess

import pytest

from backend.database import init_db
from backend.services import music_sync as ms


def _run(coro):
    return asyncio.run(coro)


def _touch(root, rel, data=b"x"):
    path = os.path.join(root, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(data)


# --- the rule itself ---------------------------------------------------------


def test_flac_with_m4a_twin_in_list_is_skipped():
    paths = ["/A/x/01 Song.m4a", "/A/x/01 Song.flac", "/A/x/02 Other.flac"]
    assert ms.flac_paths_to_skip(paths) == {"/A/x/01 Song.flac"}


def test_aac_twin_counts_and_extension_case_is_ignored():
    paths = ["/A/x/t.AAC", "/A/x/t.FLAC", "/A/x/u.M4A", "/A/x/u.flac"]
    assert ms.flac_paths_to_skip(paths) == {"/A/x/t.FLAC", "/A/x/u.flac"}


def test_twin_must_be_in_the_same_directory():
    # Same base name in a different album is a different track.
    paths = ["/A/x/01.m4a", "/A/y/01.flac"]
    assert ms.flac_paths_to_skip(paths) == set()


def test_base_name_with_dots_matches_whole_stem():
    paths = ["/A/x/01. Song (v1.2).m4a", "/A/x/01. Song (v1.2).flac", "/A/x/01. Song.flac"]
    assert ms.flac_paths_to_skip(paths) == {"/A/x/01. Song (v1.2).flac"}


def test_non_flac_files_are_never_skipped():
    paths = ["/A/x/t.m4a", "/A/x/t.mp3", "/A/x/t.wav"]
    assert ms.flac_paths_to_skip(paths) == set()


def test_list_dir_finds_twin_outside_the_selection():
    # A selection holding only the FLAC still sees the M4A on the share.
    calls = []

    def list_dir(d):
        calls.append(d)
        return ["t.m4a", "t.flac", "cover.jpg"] if d == "A/x" else None

    skip = ms.flac_paths_to_skip(["/A/x/t.flac", "/B/y/t.flac", "/B/y/u.flac"], list_dir)
    assert skip == {"/A/x/t.flac"}
    assert sorted(calls) == ["A/x", "B/y"]  # one listing per directory


def test_unreadable_directory_keeps_the_flac():
    assert ms.flac_paths_to_skip(["/A/x/t.flac"], lambda d: None) == set()


# --- the config switch -------------------------------------------------------


def test_option_defaults_off(conf_path):
    assert ms.prefer_aac_enabled() is False


@pytest.mark.parametrize("value,expected", [
    ("true", True), ("TRUE", True), ("1", True), ("yes", True), ("on", True),
    ("false", False), ("0", False), ("", False), ("maybe", False),
])
def test_option_values(conf_path, value, expected):
    with open(conf_path, "w") as fh:
        fh.write(f"export MUSIC_PREFER_AAC={value}\n")
    assert ms.prefer_aac_enabled() is expected


def test_option_can_be_set_through_config_api(client, conf_path):
    r = client.put("/api/config", json={"updates": {"MUSIC_PREFER_AAC": "true"}})
    assert r.status_code == 200
    assert r.json()["config"]["MUSIC_PREFER_AAC"] == "true"
    assert ms.prefer_aac_enabled() is True


# --- rsync exclude patterns --------------------------------------------------


def test_exclude_pattern_is_anchored_and_literal():
    assert ms._rsync_literal_pattern("A/x/t.flac") == "/A/x/t.flac"
    assert ms._rsync_literal_pattern("/A/x/t.flac") == "/A/x/t.flac"
    assert ms._rsync_literal_pattern("A/Why?/t [live].flac") == r"/A/Why\?/t \[live].flac"
    assert ms._rsync_literal_pattern("A\\B/*.flac") == r"/A\\B/\*.flac"


@pytest.mark.skipif(shutil.which("rsync") is None, reason="rsync not installed")
def test_real_rsync_with_exclude_file_copies_lone_flac_and_deletes_nothing(tmp_path):
    src = str(tmp_path / "src")
    dst = str(tmp_path / "dst")
    _touch(src, "A/x/01 Song.m4a")
    _touch(src, "A/x/01 Song.flac")          # has a twin: must not copy
    _touch(src, "A/x/02 Only Flac.flac")     # no twin: must copy
    _touch(src, "B/Why? [live]/t*.flac")     # wildcard chars in the name
    _touch(src, "B/Why? [live]/t*.m4a")
    _touch(dst, "A/x/01 Song.flac", b"old")  # already on the drive: must survive

    skip = ms.flac_paths_to_skip(ms._walk_share_files(src))
    assert skip == {"A/x/01 Song.flac", "B/Why? [live]/t*.flac"}
    exclude = ms._write_exclude_file(skip)
    try:
        subprocess.run(
            ["rsync", "-a", f"--exclude-from={exclude}", src + "/", dst + "/"],
            check=True, capture_output=True,
        )
    finally:
        os.unlink(exclude)

    copied = set(ms._walk_share_files(dst))
    assert "A/x/01 Song.m4a" in copied
    assert "A/x/02 Only Flac.flac" in copied
    assert "B/Why? [live]/t*.m4a" in copied
    assert "B/Why? [live]/t*.flac" not in copied
    # Pre-existing FLAC is left alone: no delete, no overwrite.
    with open(os.path.join(dst, "A/x/01 Song.flac"), "rb") as fh:
        assert fh.read() == b"old"


# --- wiring into the sync paths ---------------------------------------------


def _job_with_totals(db_path, files_total, bytes_total):
    con = sqlite3.connect(db_path)
    cur = con.execute(
        "INSERT INTO music_sync_jobs (status, mode, files_total, bytes_total) VALUES ('running','selective',?,?)",
        (files_total, bytes_total),
    )
    con.commit()
    jid = cur.lastrowid
    con.close()
    return jid


def _seed(db_path, paths, size=100):
    con = sqlite3.connect(db_path)
    con.executemany(
        "INSERT INTO music_files (path, artist, album, size_bytes, synced) VALUES (?,?,?,?,0)",
        [(p, p.split("/")[1], p.split("/")[2], size) for p in paths],
    )
    con.commit()
    con.close()


def test_selective_drop_uses_the_share_and_shrinks_totals(db_path, tmp_path, monkeypatch):
    _run(init_db())
    share = str(tmp_path / "share")
    _touch(share, "A/x/t.m4a")
    _touch(share, "A/x/t.flac")
    _touch(share, "A/x/u.flac")
    monkeypatch.setattr(ms, "SHARE_MOUNT", share)
    _seed(db_path, ["/A/x/t.flac", "/A/x/u.flac"])
    jid = _job_with_totals(db_path, 2, 200)

    # The selection holds only FLACs; the M4A twin is found on the share.
    kept = _run(ms._drop_flacs_with_aac(jid, ["/A/x/t.flac", "/A/x/u.flac"], db_path))
    assert kept == ["/A/x/u.flac"]

    con = sqlite3.connect(db_path)
    files_total, bytes_total = con.execute(
        "SELECT files_total, bytes_total FROM music_sync_jobs WHERE id=?", (jid,)
    ).fetchone()
    con.close()
    assert (files_total, bytes_total) == (1, 100)


def _stub_supervise(monkeypatch, seen):
    async def fake_supervise(job_id, db_path, extra_args, **kw):
        seen["args"] = list(extra_args)
        for arg in extra_args:
            if arg.startswith("--exclude-from="):
                path = arg.split("=", 1)[1]
                seen["file"] = path
                with open(path) as fh:
                    seen["patterns"] = fh.read().splitlines()
        return True, 0, "", 0

    monkeypatch.setattr(ms, "_supervise_rsync", fake_supervise)


def test_full_sync_passes_exclude_file_when_on(db_path, conf_path, tmp_path, monkeypatch):
    _run(init_db())
    with open(conf_path, "w") as fh:
        fh.write("MUSIC_PREFER_AAC=true\n")
    share = str(tmp_path / "share")
    _touch(share, "A/x/t.m4a")
    _touch(share, "A/x/t.flac")
    _touch(share, "A/x/u.flac")
    monkeypatch.setattr(ms, "SHARE_MOUNT", share)
    jid = _job_with_totals(db_path, 0, 0)
    seen = {}
    _stub_supervise(monkeypatch, seen)

    _run(ms._run_rsync_full(jid, db_path))

    assert seen["patterns"] == ["/A/x/t.flac"]
    assert not os.path.exists(seen["file"])  # temp file cleaned up
    # No rsync argument that could delete anything on the drive.
    assert not any(a.startswith("--delete") for a in seen["args"])


def test_full_sync_unchanged_when_off(db_path, conf_path, tmp_path, monkeypatch):
    _run(init_db())
    share = str(tmp_path / "share")
    _touch(share, "A/x/t.m4a")
    _touch(share, "A/x/t.flac")
    monkeypatch.setattr(ms, "SHARE_MOUNT", share)
    jid = _job_with_totals(db_path, 0, 0)
    seen = {}
    _stub_supervise(monkeypatch, seen)

    _run(ms._run_rsync_full(jid, db_path))

    assert seen["args"] == []


def _spy_start_sync(monkeypatch):
    captured = {}

    async def fake_start_sync(paths, mode, db_path):
        captured["paths"] = list(paths)
        return 42

    monkeypatch.setattr(ms, "start_sync", fake_start_sync)
    return captured


def test_sync_new_skips_albums_whose_only_unsynced_files_are_skipped_flacs(
    client, db_path, conf_path, monkeypatch,
):
    with open(conf_path, "w") as fh:
        fh.write("MUSIC_PREFER_AAC=true\n")
    con = sqlite3.connect(db_path)
    con.executemany(
        "INSERT INTO music_files (path, artist, album, size_bytes, synced) VALUES (?,?,?,?,?)",
        [
            ("/A/x/t.m4a", "A", "x", 100, 1),
            ("/A/x/t.flac", "A", "x", 100, 0),   # twin exists: not "new"
            ("/B/y/u.flac", "B", "y", 100, 0),   # lone FLAC: new
            ("/C/z/v.m4a", "C", "z", 100, 0),    # unsynced M4A: new
        ],
    )
    con.commit()
    con.close()
    captured = _spy_start_sync(monkeypatch)

    r = client.post("/api/music/sync/new")
    assert r.status_code == 200
    assert set(captured["paths"]) == {"/B/y", "/C/z"}


def test_sync_new_offers_every_unsynced_album_when_off(client, db_path, conf_path, monkeypatch):
    con = sqlite3.connect(db_path)
    con.executemany(
        "INSERT INTO music_files (path, artist, album, size_bytes, synced) VALUES (?,?,?,?,?)",
        [("/A/x/t.m4a", "A", "x", 100, 1), ("/A/x/t.flac", "A", "x", 100, 0)],
    )
    con.commit()
    con.close()
    captured = _spy_start_sync(monkeypatch)

    r = client.post("/api/music/sync/new")
    assert r.status_code == 200
    assert captured["paths"] == ["/A/x"]
