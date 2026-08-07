"""Integration test for index_library's reconciliation (the de-dupe -> re-index path).

After the user reorganizes/de-dupes the share, a re-index must: insert new files,
reset synced=0 on changed files, and PRUNE files removed from the share — otherwise
stale rows cause rsync link_stat failures (partial syncs) forever.
"""
import asyncio
import os
import sqlite3

from backend.services import music_index


def _make_share(tmp_path):
    share = tmp_path / "share"
    (share / "Artist A" / "Album 1").mkdir(parents=True)
    (share / "Artist A" / "Album 1" / "01 track.mp3").write_text("aaaa")   # will be "changed"
    (share / "Artist B" / "Album 2").mkdir(parents=True)
    (share / "Artist B" / "Album 2" / "02 song.flac").write_text("bbbb")   # brand new
    return str(share)


def test_reindex_inserts_updates_and_prunes(db_path, tmp_path, monkeypatch):
    # conftest forces dev_mode=True, which makes index_library emit MOCK data instead
    # of walking the filesystem. Force it off so the real reconciliation path runs.
    from backend.config import settings
    monkeypatch.setattr(settings, "dev_mode", False)

    async def go():
        from backend.database import init_db
        await init_db()
        share = _make_share(tmp_path)

        # Seed: a stale row (file no longer on the share) marked synced, and the
        # "01 track.mp3" row with a WRONG mtime so re-index sees it as changed.
        con = sqlite3.connect(db_path)
        con.execute(
            "INSERT INTO music_files (path, artist, album, filename, size_bytes, modified_at, synced) "
            "VALUES ('/Gone/Old/removed.mp3','Gone','Old','removed.mp3',10,111,1)")
        con.execute(
            "INSERT INTO music_files (path, artist, album, filename, size_bytes, modified_at, synced) "
            "VALUES ('/Artist A/Album 1/01 track.mp3','Artist A','Album 1','01 track.mp3',1,1,1)")
        con.commit(); con.close()

        stats = await music_index.index_library(share, db_path)

        con = sqlite3.connect(db_path); con.row_factory = sqlite3.Row
        rows = {r["path"]: r for r in con.execute("SELECT path, synced FROM music_files")}
        con.close()

        # stale removed
        assert "/Gone/Old/removed.mp3" not in rows
        assert stats["removed"] == 1
        # new file inserted, unsynced
        newp = "/Artist B/Album 2/02 song.flac"
        assert newp in rows and rows[newp]["synced"] == 0
        assert stats["inserted"] == 1
        # changed file: synced reset to 0 so Sync New re-copies it
        chp = "/Artist A/Album 1/01 track.mp3"
        assert rows[chp]["synced"] == 0
        assert stats["updated"] == 1

    asyncio.run(go())
