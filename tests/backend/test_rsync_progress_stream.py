"""Cover _stream_rsync_progress: the sync engine's cumulative byte accounting.

The subtle bits: (a) bytes reported to the DB are bytes_offset + this-run bytes, so the
UI total stays monotonic across retries; (b) rsync separates progress with \r, and a
line can split across read() chunks — the buffer must reassemble it.
"""
import asyncio
import pytest

from backend.services import music_sync as ms


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


def _run(coro):
    return asyncio.run(coro)


def test_cumulative_offset_and_chunk_split(db_path, monkeypatch):
    writes = []

    async def fake_update(_db, _job, **kw):
        writes.append(kw)

    monkeypatch.setattr(ms, "_update_job", fake_update)
    ms._active_sync["cancelled"] = False

    # A progress2 line ends with \r. Split the SECOND line across two chunks to
    # exercise the buffer reassembly.
    chunks = [
        b"    1,000  1%  1.0MB/s  0:00:01 (xfr#1, to-chk=5/10)\r",
        b"    5,000  5%  1.0MB/s  0:00:02 (xfr#3, ",
        b"to-chk=2/10)\r",
        b"",  # EOF
    ]
    progress = {"run_bytes": 0, "files": 0}
    files, run_bytes = _run(
        ms._stream_rsync_progress(_FakeProc(chunks), db_path, 1, bytes_offset=100_000, progress=progress)
    )

    # this run's own totals (last parsed line: 5,000 bytes, to-chk=2/10 -> 8 done)
    assert run_bytes == 5000
    assert files == 8
    assert progress["run_bytes"] == 5000 and progress["files"] == 8

    # final DB write is monotonic: prior-run offset + this run's bytes
    assert writes[-1]["bytes_copied"] == 105_000
    assert writes[-1]["files_copied"] == 8


def test_stall_raises_when_silent(db_path, monkeypatch):
    async def fake_update(_db, _job, **kw):
        pass

    monkeypatch.setattr(ms, "_update_job", fake_update)
    ms._active_sync["cancelled"] = False

    class _SilentStdout:
        async def read(self, _n):
            await asyncio.sleep(10)  # never yields within the stall window
            return b""

    class _SilentProc:
        stdout = _SilentStdout()
        returncode = None

        def kill(self):
            pass

        async def wait(self):
            return 0

    progress = {"run_bytes": 0, "files": 0}
    with pytest.raises(ms._RsyncStalled):
        _run(
            ms._stream_rsync_progress(
                _SilentProc(), db_path, 1, progress=progress, stall_timeout=0.05
            )
        )
