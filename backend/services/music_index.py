"""Music library FTS5 indexer — walks a mounted share and indexes into SQLite."""

import logging
import os
import time
from pathlib import Path

import aiosqlite

from backend.config import settings
from backend.services.share_browser import AUDIO_EXTENSIONS

logger = logging.getLogger(__name__)

# Indexing state (module-level for status polling)
_indexing_state: dict = {
    "active": False,
    "total_files": 0,
    "indexed_files": 0,
    "started_at": None,
    "completed_at": None,
    "error": None,
}


def get_indexing_status() -> dict:
    """Return current indexing progress."""
    return dict(_indexing_state)


def try_claim_indexing() -> bool:
    """Synchronously reserve the indexing slot; returns False if already active.

    Indexing and syncing must not overlap: they contend for the source share and
    both write music_files.synced — a sync marking files synced=1 could otherwise
    clobber a concurrent re-index's synced=0 reset (data loss: a changed file hidden
    from "Sync New"). Callers claim this before starting index_library; start_sync
    refuses while it's held. Being synchronous (no await), the claim is atomic.
    """
    if _indexing_state.get("active"):
        return False
    _indexing_state["active"] = True
    return True


async def index_library(mountpoint: str, db_path: str) -> dict:
    """Walk the mount and index artist/album/track into the database.

    Expected structure: /{Artist}/{Album}/{track.ext} or /{Artist}/{track.ext}

    Returns stats dict with counts.
    """
    global _indexing_state
    _indexing_state = {
        "active": True,
        "total_files": 0,
        "indexed_files": 0,
        "started_at": time.time(),
        "completed_at": None,
        "error": None,
    }

    if settings.dev_mode:
        return await _index_mock(db_path)

    try:
        # Phase 1: Walk and collect file list
        # Run in thread pool to avoid blocking the uvicorn event loop
        import asyncio

        def _walk_share(mountpoint: str) -> list[dict]:
            """Breadth-first walk — ensures all artists are reached.

            Standard os.walk goes depth-first, which on a large CIFS share
            over WAN means it spends all its time in the first few artist
            dirs and never reaches the rest. This scans artist dirs first
            (breadth), then walks each artist's albums.
            """
            result = []
            mount_path = Path(mountpoint)

            # Phase 1: List all top-level artist directories
            try:
                top_entries = sorted(os.scandir(mountpoint), key=lambda e: e.name.lower())
            except OSError as exc:
                logger.error("Failed to list mount root: %s", exc)
                return result

            artist_dirs = [e for e in top_entries if e.is_dir() and not e.name.startswith(".")]
            total_artists = len(artist_dirs)
            logger.info("Found %d top-level artist directories", total_artists)
            _indexing_state["total_files"] = total_artists

            # Phase 2: Walk each artist directory
            walked = 0
            skipped = 0
            for artist_idx, artist_entry in enumerate(artist_dirs):
                artist_name = artist_entry.name

                if (artist_idx + 1) % 50 == 0:
                    _indexing_state["indexed_files"] = artist_idx + 1
                    _indexing_state["total_files"] = total_artists
                    logger.info("Indexing artist %d/%d: %s (%d files, %d walked, %d skipped)",
                                artist_idx + 1, total_artists, artist_name,
                                len(result), walked, skipped)

                try:
                    # Walk this artist's tree (limited depth)
                    artist_path = os.path.join(mountpoint, artist_name)
                    for root, dirs, filenames in os.walk(artist_path):
                        dirs[:] = [d for d in dirs if not d.startswith(".")]

                        # Limit depth to 3 levels (artist/album/disc)
                        rel_root = os.path.relpath(root, mountpoint)
                        depth = rel_root.count(os.sep)
                        if depth > 3:
                            dirs.clear()
                            continue

                        for fname in filenames:
                            if fname.startswith("."):
                                continue
                            ext = Path(fname).suffix.lower()
                            if ext not in AUDIO_EXTENSIONS:
                                continue

                            full = Path(root) / fname
                            rel = full.relative_to(mount_path)
                            parts = rel.parts

                            artist = parts[0] if len(parts) >= 2 else "Unknown"
                            album = parts[1] if len(parts) >= 3 else ""

                            try:
                                st = full.stat()
                                size = st.st_size
                                mtime = st.st_mtime
                            except OSError:
                                size = 0
                                mtime = 0

                            result.append({
                                "path": "/" + str(rel),
                                "artist": artist,
                                "album": album,
                                "filename": fname,
                                "size_bytes": size,
                                "modified_at": mtime,
                            })

                    walked += 1

                except OSError as exc:
                    logger.warning("Failed to walk artist '%s': %s", artist_name, exc)
                    skipped += 1
                    continue

            logger.info("Walk complete: %d walked, %d skipped, %d files found",
                        walked, skipped, len(result))
            _indexing_state["indexed_files"] = total_artists
            return result

        logger.info("Starting library walk (in thread pool to avoid blocking API)...")
        loop = asyncio.get_event_loop()
        files = await loop.run_in_executor(None, _walk_share, mountpoint)

        _indexing_state["total_files"] = len(files)
        logger.info("Found %d audio files to index", len(files))

        # Phase 2: Insert into database incrementally
        async with aiosqlite.connect(db_path) as db:
            db.row_factory = aiosqlite.Row
            await db.execute("PRAGMA journal_mode=WAL")

            # Get existing paths for incremental updates
            existing = {}
            async with db.execute("SELECT path, modified_at FROM music_files") as cursor:
                async for row in cursor:
                    existing[row["path"]] = row["modified_at"]

            inserted = 0
            updated = 0
            batch_size = 500

            for i in range(0, len(files), batch_size):
                batch = files[i : i + batch_size]
                for f in batch:
                    if f["path"] not in existing:
                        await db.execute(
                            """INSERT INTO music_files
                               (path, artist, album, filename, size_bytes, modified_at)
                               VALUES (?, ?, ?, ?, ?, ?)""",
                            (f["path"], f["artist"], f["album"],
                             f["filename"], f["size_bytes"], f["modified_at"]),
                        )
                        inserted += 1
                    elif existing[f["path"]] != f["modified_at"]:
                        # The file changed on the share — reset synced so "Sync New"
                        # (which selects synced=0) re-copies the updated version.
                        await db.execute(
                            """UPDATE music_files
                               SET artist=?, album=?, filename=?, size_bytes=?, modified_at=?,
                                   synced=0, indexed_at=CURRENT_TIMESTAMP
                               WHERE path=?""",
                            (f["artist"], f["album"], f["filename"],
                             f["size_bytes"], f["modified_at"], f["path"]),
                        )
                        updated += 1

                await db.commit()
                _indexing_state["indexed_files"] = min(i + batch_size, len(files))

            # Remove files no longer on disk
            current_paths = {f["path"] for f in files}
            stale = set(existing.keys()) - current_paths
            if stale:
                for path in stale:
                    await db.execute("DELETE FROM music_files WHERE path = ?", (path,))
                await db.commit()
                logger.info("Removed %d stale entries", len(stale))

        stats = {
            "total_files": len(files),
            "inserted": inserted,
            "updated": updated,
            "removed": len(stale) if stale else 0,
        }
        logger.info("Indexing complete: %s", stats)

        _indexing_state["active"] = False
        _indexing_state["completed_at"] = time.time()
        _indexing_state["indexed_files"] = len(files)
        return stats

    except Exception as exc:
        logger.error("Indexing failed: %s", exc)
        _indexing_state["active"] = False
        _indexing_state["error"] = str(exc)
        raise


async def _index_mock(db_path: str) -> dict:
    """Populate the database with mock music data (~50,000 tracks)."""
    import asyncio
    import random

    global _indexing_state

    genres = {
        "Rock": [
            "Radiohead", "Pink Floyd", "Led Zeppelin", "The Beatles", "David Bowie",
            "The Rolling Stones", "Fleetwood Mac", "Queen", "The Who", "Jimi Hendrix",
            "Nirvana", "Pearl Jam", "Soundgarden", "Alice in Chains", "R.E.M.",
            "U2", "Coldplay", "Muse", "Arctic Monkeys", "The Strokes",
            "The White Stripes", "The Black Keys", "Foo Fighters", "Weezer", "Green Day",
        ],
        "Jazz": [
            "Miles Davis", "John Coltrane", "Thelonious Monk", "Bill Evans", "Charles Mingus",
            "Duke Ellington", "Herbie Hancock", "Wayne Shorter", "Sonny Rollins", "Art Blakey",
            "Dave Brubeck", "Ornette Coleman", "Chet Baker", "Ella Fitzgerald", "Billie Holiday",
            "Nina Simone", "Oscar Peterson", "Keith Jarrett", "Pat Metheny", "Wynton Marsalis",
            "Brad Mehldau", "Kamasi Washington", "Robert Glasper", "Esperanza Spalding", "Snarky Puppy",
        ],
        "Electronic": [
            "Aphex Twin", "Boards of Canada", "Burial", "Four Tet", "Tycho",
            "Bonobo", "Caribou", "Jon Hopkins", "Floating Points", "Amon Tobin",
            "Autechre", "Squarepusher", "Plaid", "Clark", "Rival Consoles",
            "Kiasmos", "Nils Frahm", "Olafur Arnalds", "Max Cooper", "Bicep",
            "Ross From Friends", "DJ Shadow", "The Avalanches", "Massive Attack", "Portishead",
        ],
        "Folk": [
            "Bob Dylan", "Neil Young", "Joni Mitchell", "Nick Drake", "Leonard Cohen",
            "Townes Van Zandt", "Elliott Smith", "Sufjan Stevens", "Iron & Wine", "Bon Iver",
            "Fleet Foxes", "The Tallest Man on Earth", "Vashti Bunyan", "Bert Jansch", "John Fahey",
            "Gillian Welch", "Jason Isbell", "Sturgill Simpson", "Tyler Childers", "Billy Strings",
            "Phoebe Bridgers", "Big Thief", "Adrianne Lenker", "Angel Olsen", "Weyes Blood",
        ],
        "Classical": [
            "Glenn Gould", "Martha Argerich", "Yo-Yo Ma", "Itzhak Perlman", "Hilary Hahn",
            "Lang Lang", "Yuja Wang", "Daniel Barenboim", "Anne-Sophie Mutter", "Murray Perahia",
            "Krystian Zimerman", "Mitsuko Uchida", "Andras Schiff", "Daniil Trifonov", "Igor Levit",
            "Maxim Vengerov", "Janine Jansen", "Sol Gabetta", "Patricia Kopatchinskaja", "Khatia Buniatishvili",
            "Steven Isserlis", "Alisa Weilerstein", "Leonidas Kavakos", "Christian Tetzlaff", "Isabelle Faust",
        ],
        "R&B/Soul": [
            "Marvin Gaye", "Stevie Wonder", "Aretha Franklin", "Al Green", "Curtis Mayfield",
            "D'Angelo", "Erykah Badu", "Lauryn Hill", "Frank Ocean", "SZA",
            "Solange", "Anderson .Paak", "H.E.R.", "Daniel Caesar", "Jorja Smith",
            "Summer Walker", "Giveon", "Snoh Aalegra", "Ravyn Lenae", "Steve Lacy",
            "Thundercat", "Tom Misch", "Jordan Rakei", "Sampha", "James Blake",
        ],
        "Country": [
            "Johnny Cash", "Willie Nelson", "Waylon Jennings", "Merle Haggard", "George Jones",
            "Hank Williams", "Patsy Cline", "Dolly Parton", "Emmylou Harris", "Kris Kristofferson",
            "Chris Stapleton", "Colter Wall", "Charley Crockett", "Sierra Ferrell", "Zach Bryan",
            "Morgan Wallen", "Luke Combs", "Cody Jinks", "Turnpike Troubadours", "Midland",
            "Orville Peck", "Lainey Wilson", "Hailey Whitters", "Flatland Cavalry", "Caamp",
        ],
        "World": [
            "Fela Kuti", "Ali Farka Toure", "Tinariwen", "Khruangbin", "Mdou Moctar",
            "Bombino", "Ravi Shankar", "Anoushka Shankar", "Nusrat Fateh Ali Khan", "Youssou N'Dour",
            "Cesaria Evora", "Buena Vista Social Club", "Amadou & Mariam", "Salif Keita", "Oumou Sangare",
            "Mulatu Astatke", "Hailu Mergia", "Orchestra Baobab", "Konono No 1", "Staff Benda Bilili",
            "Goat", "Ebo Taylor", "Tony Allen", "Damon Albarn", "Rodrigo y Gabriela",
        ],
    }

    album_templates = [
        "Debut", "Untitled", "The Return", "Live at the Village Vanguard",
        "Sessions Vol. {n}", "Collected Works", "Midnight Hour", "Dawn",
        "The River", "Blue", "Gold", "Silver", "Black", "White",
        "First Light", "Shadows", "Reflections", "Horizons", "Echoes",
    ]

    track_templates = [
        "Intro", "Opening", "First Movement", "Second Movement",
        "Interlude", "Bridge", "Main Theme", "Variation {n}",
        "Closing", "Finale", "Coda", "Reprise", "Outro",
    ]

    extensions = [".flac", ".mp3", ".m4a", ".ogg"]

    total_tracks = 0
    all_files = []

    for genre, artists in genres.items():
        for artist in artists:
            n_albums = random.randint(3, 8)
            for a_idx in range(n_albums):
                album = random.choice(album_templates).replace("{n}", str(a_idx + 1))
                album = f"{album} ({2000 + random.randint(0, 24)})"
                n_tracks = random.randint(8, 16)
                for t_idx in range(1, n_tracks + 1):
                    ext = random.choice(extensions)
                    track_name = random.choice(track_templates).replace("{n}", str(t_idx))
                    filename = f"{t_idx:02d} {track_name}{ext}"
                    size = random.randint(15_000_000, 80_000_000)
                    all_files.append({
                        "path": f"/{artist}/{album}/{filename}",
                        "artist": artist,
                        "album": album,
                        "filename": filename,
                        "size_bytes": size,
                        "modified_at": 1700000000 + random.randint(0, 10000000),
                    })
                    total_tracks += 1

    _indexing_state["total_files"] = total_tracks
    logger.info("Dev mode: generating %d mock tracks", total_tracks)

    async with aiosqlite.connect(db_path) as db:
        await db.execute("PRAGMA journal_mode=WAL")

        # Check if already populated
        async with db.execute("SELECT COUNT(*) FROM music_files") as cursor:
            row = await cursor.fetchone()
            if row and row[0] > 1000:
                _indexing_state["active"] = False
                _indexing_state["completed_at"] = time.time()
                _indexing_state["indexed_files"] = row[0]
                return {"total_files": row[0], "inserted": 0, "updated": 0, "removed": 0, "skipped": True}

        # Clear and re-insert
        await db.execute("DELETE FROM music_files")
        await db.commit()

        batch_size = 500
        for i in range(0, len(all_files), batch_size):
            batch = all_files[i : i + batch_size]
            # OR IGNORE: randomly-generated mock album names can collide (same template
            # + year), producing duplicate paths — without this the whole dev re-index
            # crashes on a UNIQUE violation. Dropping the rare collision is fine here.
            await db.executemany(
                """INSERT OR IGNORE INTO music_files
                   (path, artist, album, filename, size_bytes, modified_at)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                [(f["path"], f["artist"], f["album"],
                  f["filename"], f["size_bytes"], f["modified_at"]) for f in batch],
            )
            await db.commit()
            _indexing_state["indexed_files"] = min(i + batch_size, total_tracks)
            await asyncio.sleep(0.01)  # yield to event loop

    _indexing_state["active"] = False
    _indexing_state["completed_at"] = time.time()
    return {
        "total_files": total_tracks,
        "inserted": total_tracks,
        "updated": 0,
        "removed": 0,
    }


async def search(db_path: str, query: str, limit: int = 50) -> list[dict]:
    """Full-text search returning matching tracks grouped by artist/album."""
    async with aiosqlite.connect(db_path) as db:
        db.row_factory = aiosqlite.Row
        await db.execute("PRAGMA journal_mode=WAL")

        # Escape FTS5 special characters and append wildcard
        safe_query = query.replace('"', '""')
        fts_query = f'"{safe_query}"*'

        rows = []
        async with db.execute(
            """SELECT m.id, m.path, m.artist, m.album, m.filename, m.size_bytes,
                      m.synced
               FROM music_library l
               JOIN music_files m ON l.rowid = m.id
               WHERE music_library MATCH ?
               ORDER BY rank
               LIMIT ?""",
            (fts_query, limit),
        ) as cursor:
            async for row in cursor:
                rows.append(dict(row))

    # Group by artist -> album
    grouped: dict[str, dict] = {}
    for row in rows:
        artist = row["artist"] or "Unknown"
        album = row["album"] or "Singles"
        key = f"{artist}||{album}"
        if key not in grouped:
            grouped[key] = {
                "artist": artist,
                "album": album,
                "tracks": [],
                "total_size": 0,
            }
        grouped[key]["tracks"].append({
            "id": row["id"],
            "path": row["path"],
            "filename": row["filename"],
            "size_bytes": row["size_bytes"],
            "synced": bool(row["synced"]),
        })
        grouped[key]["total_size"] += row["size_bytes"]

    return list(grouped.values())


async def get_artists(db_path: str, limit: int = 50, offset: int = 0, search_query: str = "") -> list[dict]:
    """Paginated artist list with track/album counts and total size."""
    async with aiosqlite.connect(db_path) as db:
        db.row_factory = aiosqlite.Row
        await db.execute("PRAGMA journal_mode=WAL")

        if search_query:
            safe = search_query.replace("%", "\\%").replace("_", "\\_")
            query = """
                SELECT artist,
                       COUNT(*) as track_count,
                       COUNT(DISTINCT album) as album_count,
                       SUM(size_bytes) as total_size
                FROM music_files
                WHERE artist LIKE ? ESCAPE '\\'
                GROUP BY artist
                ORDER BY artist COLLATE NOCASE
                LIMIT ? OFFSET ?
            """
            params = (f"%{safe}%", limit, offset)
        else:
            query = """
                SELECT artist,
                       COUNT(*) as track_count,
                       COUNT(DISTINCT album) as album_count,
                       SUM(size_bytes) as total_size
                FROM music_files
                GROUP BY artist
                ORDER BY artist COLLATE NOCASE
                LIMIT ? OFFSET ?
            """
            params = (limit, offset)

        artists = []
        async with db.execute(query, params) as cursor:
            async for row in cursor:
                artists.append(dict(row))

        # Get total count for pagination
        if search_query:
            safe = search_query.replace("%", "\\%").replace("_", "\\_")
            count_query = """
                SELECT COUNT(DISTINCT artist) as total
                FROM music_files
                WHERE artist LIKE ? ESCAPE '\\'
            """
            count_params = (f"%{safe}%",)
        else:
            count_query = "SELECT COUNT(DISTINCT artist) as total FROM music_files"
            count_params = ()

        async with db.execute(count_query, count_params) as cursor:
            row = await cursor.fetchone()
            total = row["total"] if row else 0

    return {"artists": artists, "total": total}


async def get_albums(db_path: str, artist: str) -> list[dict]:
    """Albums for a specific artist with track counts and size."""
    async with aiosqlite.connect(db_path) as db:
        db.row_factory = aiosqlite.Row
        await db.execute("PRAGMA journal_mode=WAL")

        albums = []
        async with db.execute(
            """SELECT album,
                      COUNT(*) as track_count,
                      SUM(size_bytes) as total_size
               FROM music_files
               WHERE artist = ?
               GROUP BY album
               ORDER BY album COLLATE NOCASE""",
            (artist,),
        ) as cursor:
            async for row in cursor:
                albums.append(dict(row))

    return albums


async def get_random(db_path: str, count: int = 20, item_type: str = "artist") -> list[dict]:
    """Return N random artists or albums from the index."""
    async with aiosqlite.connect(db_path) as db:
        db.row_factory = aiosqlite.Row
        await db.execute("PRAGMA journal_mode=WAL")

        if item_type == "album":
            rows = []
            async with db.execute(
                """SELECT artist, album,
                          COUNT(*) as track_count,
                          SUM(size_bytes) as total_size
                   FROM music_files
                   WHERE album != ''
                   GROUP BY artist, album
                   ORDER BY RANDOM()
                   LIMIT ?""",
                (count,),
            ) as cursor:
                async for row in cursor:
                    rows.append(dict(row))
            return rows
        else:
            # Default: random artists
            rows = []
            async with db.execute(
                """SELECT artist,
                          COUNT(*) as track_count,
                          COUNT(DISTINCT album) as album_count,
                          SUM(size_bytes) as total_size
                   FROM music_files
                   GROUP BY artist
                   ORDER BY RANDOM()
                   LIMIT ?""",
                (count,),
            ) as cursor:
                async for row in cursor:
                    rows.append(dict(row))
            return rows


async def get_recent(db_path: str, count: int = 50) -> list[dict]:
    """Return most recently modified items (grouped by artist/album)."""
    async with aiosqlite.connect(db_path) as db:
        db.row_factory = aiosqlite.Row
        await db.execute("PRAGMA journal_mode=WAL")

        rows = []
        async with db.execute(
            """SELECT artist, album,
                      COUNT(*) as track_count,
                      SUM(size_bytes) as total_size,
                      MAX(modified_at) as latest_modified
               FROM music_files
               WHERE album != ''
               GROUP BY artist, album
               ORDER BY latest_modified DESC
               LIMIT ?""",
            (count,),
        ) as cursor:
            async for row in cursor:
                rows.append(dict(row))

    return rows


async def get_stats(db_path: str) -> dict:
    """Library statistics: total artists, albums, tracks, size."""
    async with aiosqlite.connect(db_path) as db:
        db.row_factory = aiosqlite.Row
        await db.execute("PRAGMA journal_mode=WAL")

        async with db.execute(
            """SELECT
                 COUNT(DISTINCT artist) as total_artists,
                 COUNT(DISTINCT album) as total_albums,
                 COUNT(*) as total_tracks,
                 COALESCE(SUM(size_bytes), 0) as total_size
               FROM music_files"""
        ) as cursor:
            row = await cursor.fetchone()
            if row:
                return dict(row)

    return {
        "total_artists": 0,
        "total_albums": 0,
        "total_tracks": 0,
        "total_size": 0,
    }
