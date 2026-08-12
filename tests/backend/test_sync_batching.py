"""Cover the batched, resumable selective-sync path.

Why this exists: a full-library "Sync New" built one giant ``--files-from`` and handed
it to a single rsync. rsync is SILENT during its file-list build (``--info=progress2``
prints nothing until it transfers), so on a large list that silent scan outran the 90s
stall watchdog — rsync was killed and retried forever with zero bytes copied. The fix
rsyncs the list in bounded batches (fast scans) and checkpoints each batch so an
interrupted sync resumes. These tests lock the batching, the per-batch checkpointing,
and the monotonic cumulative accounting — without running a real rsync or the gadget
lifecycle (``_supervise_rsync`` is stubbed).
"""
import asyncio
import sqlite3

import pytest

from backend.database import init_db
from backend.services import music_sync as ms


def _run(coro):
    return asyncio.run(coro)


def _init(db_path):
    _run(init_db())  # uses settings.database_path, patched by the db_path fixture


def _seed(db_path, paths, synced=0):
    con = sqlite3.connect(db_path)
    con.executemany(
        "INSERT INTO music_files (path, artist, album, size_bytes, synced) VALUES (?,?,?,?,?)",
        [(p, p.split("/")[1], p.split("/")[2], 100, synced) for p in paths],
    )
    con.commit()
    con.close()


def _new_job(db_path):
    con = sqlite3.connect(db_path)
    cur = con.execute("INSERT INTO music_sync_jobs (status, mode) VALUES ('running','selective')")
    con.commit()
    jid = cur.lastrowid
    con.close()
    return jid


def _job(db_path, jid):
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    row = con.execute("SELECT * FROM music_sync_jobs WHERE id=?", (jid,)).fetchone()
    con.close()
    return dict(row)


def _synced(db_path):
    con = sqlite3.connect(db_path)
    rows = con.execute("SELECT path FROM music_files WHERE synced=1").fetchall()
    con.close()
    return {r[0] for r in rows}


def _patch_supervise(monkeypatch, script):
    """Stub _supervise_rsync with a scripted list of (success, rc, err, run_bytes).

    Records each call's files_from contents and the bytes/files offsets it was handed
    so tests can assert batching + monotonic accounting.
    """
    calls = {"batches": [], "bytes_offsets": [], "files_offsets": [], "n": 0}

    async def fake(job_id, db_path, extra_args, *, bytes_offset=0, files_offset=0):
        files_from = extra_args[0].split("=", 1)[1]
        with open(files_from) as fh:
            calls["batches"].append(fh.read().splitlines())
        calls["bytes_offsets"].append(bytes_offset)
        calls["files_offsets"].append(files_offset)
        result = script[calls["n"]]
        calls["n"] += 1
        return result

    monkeypatch.setattr(ms, "_supervise_rsync", fake)
    return calls


# --- _batch_file_list --------------------------------------------------------

def test_batch_sizes_order_and_completeness():
    fl = [f"/a/b/{i}.mp3" for i in range(125)]
    batches = ms._batch_file_list(fl, 50)
    assert [len(b) for b in batches] == [50, 50, 25]
    # order preserved and nothing dropped/duplicated
    assert [p for b in batches for p in b] == fl


def test_batch_empty_is_no_batches():
    assert ms._batch_file_list([], 50) == []


def test_batch_max_files_clamped_to_one():
    fl = ["/a/b/1.mp3", "/a/b/2.mp3"]
    assert ms._batch_file_list(fl, 0) == [["/a/b/1.mp3"], ["/a/b/2.mp3"]]


# --- files_offset accounting in the stream -----------------------------------

class _FakeStdout:
    def __init__(self, chunks):
        self._chunks = list(chunks)

    async def read(self, _n):
        return self._chunks.pop(0) if self._chunks else b""


class _FakeProc:
    def __init__(self, chunks):
        self.stdout = _FakeStdout(chunks)
        self.returncode = 0

    def kill(self):
        pass

    async def wait(self):
        return 0


def test_stream_applies_files_offset(db_path, monkeypatch):
    writes = []

    async def fake_update(_db, _job, **kw):
        writes.append(kw)

    monkeypatch.setattr(ms, "_update_job", fake_update)
    ms._active_sync["cancelled"] = False

    chunks = [b"    5,000  5%  1.0MB/s  0:00:02 (xfr#3, to-chk=2/10)\r", b""]
    files, run_bytes = _run(
        ms._stream_rsync_progress(
            _FakeProc(chunks), db_path, 1,
            bytes_offset=100_000, files_offset=500, progress={"run_bytes": 0, "files": 0},
        )
    )
    # this run parsed 8 files done (to-chk=2/10) — offset makes the DB total 508
    assert files == 8
    assert writes[-1]["files_copied"] == 508
    assert writes[-1]["bytes_copied"] == 105_000


# --- _sync_file_list_in_batches ---------------------------------------------

def test_all_batches_succeed_marks_all_and_completes(db_path, monkeypatch):
    _init(db_path)
    monkeypatch.setattr(ms, "_SYNC_BATCH_FILES", 2)
    ms._active_sync["cancelled"] = False
    paths = [f"/art/alb/{i}.mp3" for i in range(5)]  # 3 batches: 2,2,1
    _seed(db_path, paths)
    jid = _new_job(db_path)
    calls = _patch_supervise(monkeypatch, [(True, 0, "", 1000)] * 3)

    _run(ms._sync_file_list_in_batches(jid, paths, db_path))

    assert calls["n"] == 3
    assert [len(b) for b in calls["batches"]] == [2, 2, 1]
    # every file marked synced
    assert _synced(db_path) == set(paths)
    job = _job(db_path, jid)
    assert job["status"] == "completed"
    assert job["files_copied"] == 5
    # bytes counted per batch, monotonic; offsets fed forward
    assert job["bytes_copied"] == 3000
    assert calls["bytes_offsets"] == [0, 1000, 2000]
    assert calls["files_offsets"] == [0, 2, 4]


def test_partial_batch_left_unsynced_and_sync_continues(db_path, monkeypatch):
    _init(db_path)
    monkeypatch.setattr(ms, "_SYNC_BATCH_FILES", 2)
    ms._active_sync["cancelled"] = False
    paths = [f"/art/alb/{i}.mp3" for i in range(6)]  # 3 batches of 2
    _seed(db_path, paths)
    jid = _new_job(db_path)
    # middle batch is a partial (rsync 23) — must NOT abort the whole sync
    calls = _patch_supervise(monkeypatch, [
        (True, 0, "", 1000),
        (False, 23, "vanished", 500),
        (True, 0, "", 1000),
    ])

    _run(ms._sync_file_list_in_batches(jid, paths, db_path))

    assert calls["n"] == 3  # continued past the partial batch
    # batches 1 and 3 synced; batch 2 (paths[2],[3]) left for retry
    assert _synced(db_path) == {paths[0], paths[1], paths[4], paths[5]}
    job = _job(db_path, jid)
    assert job["status"] == "partial"
    assert job["files_copied"] == 4          # only the clean batches
    assert job["bytes_copied"] == 2500       # bytes counted even for the partial


def test_hard_failure_aborts_but_keeps_earlier_checkpoints(db_path, monkeypatch):
    _init(db_path)
    monkeypatch.setattr(ms, "_SYNC_BATCH_FILES", 2)
    ms._active_sync["cancelled"] = False
    paths = [f"/art/alb/{i}.mp3" for i in range(6)]  # 3 batches of 2
    _seed(db_path, paths)
    jid = _new_job(db_path)
    # batch 1 clean, batch 2 hard-fails (network code) — batch 3 must never run
    calls = _patch_supervise(monkeypatch, [
        (True, 0, "", 1000),
        (False, 12, "link down", 0),
    ])

    with pytest.raises(RuntimeError):
        _run(ms._sync_file_list_in_batches(jid, paths, db_path))

    assert calls["n"] == 2  # aborted; third batch not attempted
    # the completed batch is checkpointed so a re-run resumes from here
    assert _synced(db_path) == {paths[0], paths[1]}


def test_empty_file_list_completes_without_rsync(db_path, monkeypatch):
    _init(db_path)
    ms._active_sync["cancelled"] = False
    jid = _new_job(db_path)
    calls = _patch_supervise(monkeypatch, [])

    _run(ms._sync_file_list_in_batches(jid, [], db_path))

    assert calls["n"] == 0
    assert _job(db_path, jid)["status"] == "completed"


def test_cancel_between_batches_raises(db_path, monkeypatch):
    _init(db_path)
    monkeypatch.setattr(ms, "_SYNC_BATCH_FILES", 2)
    paths = [f"/art/alb/{i}.mp3" for i in range(6)]
    _seed(db_path, paths)
    jid = _new_job(db_path)

    # Flip the cancel flag after the first batch; the loop's top-of-iteration check
    # must then raise CancelledError before starting batch 2.
    state = {"n": 0}

    async def fake(job_id, db_path, extra_args, *, bytes_offset=0, files_offset=0):
        state["n"] += 1
        ms._active_sync["cancelled"] = True
        return (True, 0, "", 1000)

    monkeypatch.setattr(ms, "_supervise_rsync", fake)
    ms._active_sync["cancelled"] = False

    with pytest.raises(asyncio.CancelledError):
        _run(ms._sync_file_list_in_batches(jid, paths, db_path))
    assert state["n"] == 1  # only the first batch ran
    ms._active_sync["cancelled"] = False  # don't leak the flag to other tests
