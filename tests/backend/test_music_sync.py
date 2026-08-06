"""Regression tests for the music-sync engine — the loop's primary goal.

These test the job-SELECTION and GUARD logic. They do not start real (or simulated)
background syncs: `start_sync` is spied so no live task runs and no global guard is
mutated as a side effect. Guard-state tests use monkeypatch.setitem so the global is
restored automatically — no test ever force-clears a live synchronization guard.
"""

import sqlite3

import backend.services.music_index as music_index
import backend.services.music_sync as music_sync


def _seed_music(db_path, rows):
    """rows: list of (path, artist, album, synced)."""
    con = sqlite3.connect(db_path)
    con.executemany(
        "INSERT INTO music_files (path, artist, album, size_bytes, synced) VALUES (?,?,?,?,?)",
        [(p, a, al, 100, s) for (p, a, al, s) in rows],
    )
    con.commit()
    con.close()


def _spy_start_sync(monkeypatch):
    """Replace start_sync with an async spy that records its args and starts nothing."""
    captured = {}

    async def fake_start_sync(paths, mode, db_path):
        captured["paths"] = list(paths)
        captured["mode"] = mode
        return 42  # fake job id

    monkeypatch.setattr(music_sync, "start_sync", fake_start_sync)
    return captured


def test_sync_new_selects_only_unsynced_albums(client, db_path, monkeypatch):
    # iter 6b/6e: "Sync New" watermark is the `synced` flag. Only albums with an
    # unsynced file should be handed to start_sync — verified via the spy, so this
    # test covers exactly the selection query and nothing more (no live sync).
    _seed_music(db_path, [
        ("/A/x/1.mp3", "A", "x", 0),
        ("/A/x/2.mp3", "A", "x", 0),
        ("/B/y/1.mp3", "B", "y", 1),   # fully synced -> not offered
        ("/C/z/1.mp3", "C", "z", 0),
    ])
    captured = _spy_start_sync(monkeypatch)
    r = client.post("/api/music/sync/new")
    assert r.status_code == 200
    assert set(captured["paths"]) == {"/A/x", "/C/z"}
    assert captured["mode"] == "selective"


def test_sync_new_reports_nothing_when_all_synced(client, db_path, monkeypatch):
    # When everything is synced, the endpoint returns idle and never calls start_sync.
    _seed_music(db_path, [
        ("/A/x/1.mp3", "A", "x", 1),
        ("/B/y/1.mp3", "B", "y", 1),
    ])
    called = {"n": 0}

    async def fake_start_sync(paths, mode, db_path):
        called["n"] += 1
        return 1

    monkeypatch.setattr(music_sync, "start_sync", fake_start_sync)
    r = client.post("/api/music/sync/new")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "idle" and body["job_id"] is None
    assert called["n"] == 0


def test_sync_refused_while_indexing(client, db_path, monkeypatch):
    # iter 6e: sync and re-index are mutually exclusive (they race on `synced`).
    monkeypatch.setitem(music_index._indexing_state, "active", True)
    r = client.post("/api/music/sync/full")
    assert r.status_code == 409
    assert "index" in r.json()["detail"].lower()


def test_index_refused_while_syncing(client, db_path, monkeypatch):
    # The other direction: don't re-index during an active sync. Set the guard via
    # monkeypatch so it is restored automatically — never force-cleared.
    monkeypatch.setitem(music_sync._active_sync, "job_id", 999)
    r = client.post("/api/music/library/index")
    assert r.status_code == 409
    assert "sync" in r.json()["detail"].lower()


def test_parse_progress2_extracts_bytes_and_files():
    # Phase 0 (sync reliability): the --info=progress2 parser drives the UI progress
    # and the byte accounting that stays monotonic across stall-retries. Lock it.
    from backend.services.music_sync import _parse_progress2

    # Standard progress line: bytes with commas, to-chk=remaining/total -> files done.
    assert _parse_progress2(
        b"   1,234,567  45%   1.23MB/s    0:00:12 (xfr#5, to-chk=10/20)"
    ) == (1234567, 10)
    # ir-chk variant (incremental recursion) is parsed the same way.
    assert _parse_progress2(b"  500  10%  1.0MB/s  0:00:01 (xfr#1, ir-chk=3/5)") == (500, 2)
    # Completed transfer: 0 remaining -> all files done.
    assert _parse_progress2(b"  999  100%  1.0MB/s  0:00:00 (xfr#9, to-chk=0/9)") == (999, 9)
    # Non-progress lines (rsync chatter / empty) return None so the stream skips them.
    assert _parse_progress2(b"sending incremental file list") is None
    assert _parse_progress2(b"") is None
    assert _parse_progress2(b"  12345  50%  1MB/s  0:00:01") is None  # no (xfr#...) tail


def test_mountinfo_has_target_field4_parsing():
    # Phase 0 mount-safety: the image-release gate depends on correctly reading the
    # mount point (field index 4) from /proc/self/mountinfo. A wrong index would
    # misreport "not mounted" and could re-enable the gadget over a mounted image.
    from backend.services.music_sync import _mountinfo_has_target

    lines = [
        "22 96 0:21 / /proc rw,relatime shared:1 - proc proc rw",
        "24 96 0:22 / /mnt/music rw,relatime shared:2 - ext4 /dev/loop0 rw",
    ]
    assert _mountinfo_has_target(lines, "/mnt/music") is True
    assert _mountinfo_has_target(lines, "/mnt/cam") is False   # not present
    # Field index is exactly 4 (0-based), not the source path (field 3) or device.
    assert _mountinfo_has_target(["a b c d /mnt/music f - ext4 /dev/x rw"], "/mnt/music") is True
    assert _mountinfo_has_target(["a b c /mnt/music e f"], "/mnt/music") is False  # /mnt/music is field 3, not 4
    # Short/blank lines are skipped, not crashed on or false-matched.
    assert _mountinfo_has_target(["", "x y z"], "/mnt/music") is False
    assert _mountinfo_has_target([], "/mnt/music") is False


async def test_ensure_image_unmounted_release_gate(monkeypatch):
    # Phase 0 mount-safety: the gadget must only be re-presented once the image is
    # DEFINITIVELY released. Lock the fail-safe invariants of _ensure_image_unmounted.
    from backend.services import music_sync as ms

    async def _no_sleep(*a, **k):
        return None
    monkeypatch.setattr(ms.asyncio, "sleep", _no_sleep)

    class _R:
        def __init__(self, rc=0):
            self.returncode = rc
            self.stdout = ""
            self.stderr = ""
    async def _fake_run(*a, **k):
        return _R(0)
    monkeypatch.setattr(ms.script_runner, "run", _fake_run)

    async def _detach_ok(_ctx):
        return True
    async def _detach_fail(_ctx):
        return False

    # 1) unmounted AND loops detached -> released (True)
    monkeypatch.setattr(ms, "_path_mount_state", lambda _p: False)
    monkeypatch.setattr(ms, "_detach_image_loops", _detach_ok)
    assert await ms._ensure_image_unmounted(retries=1) is True

    # 2) mount state UNDETERMINABLE (None) -> never True, fail safe
    monkeypatch.setattr(ms, "_path_mount_state", lambda _p: None)
    assert await ms._ensure_image_unmounted(retries=3) is False

    # 3) unmounted but a loop stays attached -> False (a lingering loop can still write)
    monkeypatch.setattr(ms, "_path_mount_state", lambda _p: False)
    monkeypatch.setattr(ms, "_detach_image_loops", _detach_fail)
    assert await ms._ensure_image_unmounted(retries=2) is False

    # 4) still mounted after umount attempts -> False (never green-lights the gadget)
    monkeypatch.setattr(ms, "_path_mount_state", lambda _p: True)
    assert await ms._ensure_image_unmounted(retries=2) is False


def test_classify_rsync_exit_policy():
    # Phase 0 resilience: the supervisor's retry policy hinges on classifying rsync
    # exit codes. Miscategorizing means syncs retry forever or give up wrongly.
    from backend.services.music_sync import _classify_rsync_exit

    assert _classify_rsync_exit(0) == "success"
    # 23/24 = partial (vanished/unreadable) — hand back, do NOT retry forever.
    assert _classify_rsync_exit(23) == "partial"
    assert _classify_rsync_exit(24) == "partial"
    # Network-flavored codes get a fresh CIFS mount before retry.
    for rc in (30, 35, 12, 11, 14):
        assert _classify_rsync_exit(rc) == "retry_remount"
    # Any other non-zero is a plain retry (no remount).
    assert _classify_rsync_exit(1) == "retry"
    assert _classify_rsync_exit(255) == "retry"
    assert _classify_rsync_exit(None) == "retry"


async def test_reconcile_interrupted_jobs(monkeypatch, tmp_path):
    # ROOT CAUSE of "no music synced in months": a sync orphaned by a crash/restart
    # stayed status='running' forever, pinning the dashboard on "syncing". Startup
    # reconciliation must mark orphaned running/pending jobs 'interrupted'.
    import sqlite3
    from backend.config import settings
    from backend import database

    dbp = str(tmp_path / "recon.db")
    monkeypatch.setattr(settings, "database_path", dbp)
    await database.init_db()

    con = sqlite3.connect(dbp)
    con.execute("INSERT INTO music_sync_jobs (status, mode, started_at) VALUES ('running','full','2026-05-08')")
    con.execute("INSERT INTO music_sync_jobs (status, mode) VALUES ('pending','new')")
    con.execute("INSERT INTO music_sync_jobs (status, mode, completed_at) VALUES ('completed','full','2026-05-01')")
    con.execute("INSERT INTO dashcam_archive_jobs (status, trigger) VALUES ('running','auto')")
    con.commit()
    con.close()

    n = await database.reconcile_interrupted_jobs()
    assert n == 3  # 2 orphaned music (running+pending) + 1 dashcam; completed untouched

    con = sqlite3.connect(dbp)
    con.row_factory = sqlite3.Row
    music = sorted(r["status"] for r in con.execute("SELECT status FROM music_sync_jobs"))
    dc = [r["status"] for r in con.execute("SELECT status FROM dashcam_archive_jobs")]
    con.close()
    assert music == ["completed", "interrupted", "interrupted"]  # completed preserved
    assert dc == ["interrupted"]

    # Idempotent — a second startup reconciles nothing (no running/pending left).
    assert await database.reconcile_interrupted_jobs() == 0
