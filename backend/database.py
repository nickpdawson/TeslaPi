"""Async SQLite database setup with WAL mode and auto-migration."""

import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncGenerator

import aiosqlite

from backend.config import settings

logger = logging.getLogger(__name__)

_MIGRATIONS = [
    # music_files: indexed library of tracks from the network share
    """
    CREATE TABLE IF NOT EXISTS music_files (
        id INTEGER PRIMARY KEY,
        path TEXT UNIQUE NOT NULL,
        artist TEXT,
        album TEXT,
        filename TEXT,
        size_bytes INTEGER,
        modified_at TIMESTAMP,
        synced BOOLEAN DEFAULT 0,
        indexed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    """,
    # music_sync_jobs: track rsync operations
    """
    CREATE TABLE IF NOT EXISTS music_sync_jobs (
        id INTEGER PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'pending',
        mode TEXT NOT NULL,
        paths_json TEXT,
        files_total INTEGER DEFAULT 0,
        files_copied INTEGER DEFAULT 0,
        bytes_total INTEGER DEFAULT 0,
        bytes_copied INTEGER DEFAULT 0,
        error_message TEXT,
        started_at TIMESTAMP,
        completed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    """,
    # notification_channels: configured notification destinations
    """
    CREATE TABLE IF NOT EXISTS notification_channels (
        id TEXT PRIMARY KEY,
        enabled BOOLEAN DEFAULT 0,
        config_json TEXT NOT NULL,
        updated_at TIMESTAMP
    );
    """,
    # notification_history: log of sent notifications
    """
    CREATE TABLE IF NOT EXISTS notification_history (
        id INTEGER PRIMARY KEY,
        channel TEXT NOT NULL,
        event_type TEXT NOT NULL,
        title TEXT,
        message TEXT,
        status TEXT NOT NULL,
        error_message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    """,
    # notification_rules: per-event routing to channels
    """
    CREATE TABLE IF NOT EXISTS notification_rules (
        event_type TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        enabled BOOLEAN DEFAULT 1,
        PRIMARY KEY (event_type, channel_id)
    );
    """,
    # FTS5 virtual table for full-text music search
    """
    CREATE VIRTUAL TABLE IF NOT EXISTS music_library USING fts5(
        path, artist, album, filename,
        content='music_files', content_rowid='id'
    );
    """,
    # Triggers to keep FTS index in sync with music_files
    """
    CREATE TRIGGER IF NOT EXISTS music_files_ai AFTER INSERT ON music_files BEGIN
        INSERT INTO music_library(rowid, path, artist, album, filename)
        VALUES (new.id, new.path, new.artist, new.album, new.filename);
    END;
    """,
    """
    CREATE TRIGGER IF NOT EXISTS music_files_ad AFTER DELETE ON music_files BEGIN
        INSERT INTO music_library(music_library, rowid, path, artist, album, filename)
        VALUES ('delete', old.id, old.path, old.artist, old.album, old.filename);
    END;
    """,
    """
    CREATE TRIGGER IF NOT EXISTS music_files_au AFTER UPDATE ON music_files BEGIN
        INSERT INTO music_library(music_library, rowid, path, artist, album, filename)
        VALUES ('delete', old.id, old.path, old.artist, old.album, old.filename);
        INSERT INTO music_library(rowid, path, artist, album, filename)
        VALUES (new.id, new.path, new.artist, new.album, new.filename);
    END;
    """,
    # dashcam_archive_jobs: track archive operations
    """
    CREATE TABLE IF NOT EXISTS dashcam_archive_jobs (
        id INTEGER PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'pending',
        trigger TEXT NOT NULL DEFAULT 'manual',
        clips_total INTEGER DEFAULT 0,
        clips_copied INTEGER DEFAULT 0,
        bytes_total INTEGER DEFAULT 0,
        bytes_copied INTEGER DEFAULT 0,
        clips_deleted INTEGER DEFAULT 0,
        error_message TEXT,
        started_at TIMESTAMP,
        completed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    """,
    # dashcam_archived_clips: individual clip tracking
    """
    CREATE TABLE IF NOT EXISTS dashcam_archived_clips (
        id INTEGER PRIMARY KEY,
        event_type TEXT NOT NULL,
        event_dir TEXT NOT NULL,
        clip_file TEXT NOT NULL,
        size_bytes INTEGER DEFAULT 0,
        archived_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        archive_job_id INTEGER,
        deleted_from_cam BOOLEAN DEFAULT 0,
        UNIQUE(event_type, event_dir, clip_file)
    );
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_archived_clips_event ON dashcam_archived_clips(event_type, event_dir);
    """,
]


async def run_migrations(db: aiosqlite.Connection) -> None:
    """Apply all schema migrations."""
    for sql in _MIGRATIONS:
        await db.executescript(sql)
    await db.commit()
    logger.info("Database migrations applied successfully")


async def init_db() -> None:
    """Initialize database: create directory, enable WAL, run migrations."""
    db_path = Path(settings.database_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)

    async with aiosqlite.connect(str(db_path)) as db:
        await db.execute("PRAGMA journal_mode=WAL")
        await db.execute("PRAGMA foreign_keys=ON")
        await run_migrations(db)

    logger.info("Database initialized at %s", db_path)


@asynccontextmanager
async def get_db() -> AsyncGenerator[aiosqlite.Connection, None]:
    """Async context manager yielding a database connection with WAL mode."""
    async with aiosqlite.connect(str(settings.database_path)) as db:
        db.row_factory = aiosqlite.Row
        await db.execute("PRAGMA journal_mode=WAL")
        await db.execute("PRAGMA foreign_keys=ON")
        try:
            yield db
        finally:
            await db.commit()
