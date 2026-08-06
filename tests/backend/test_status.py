

def test_parse_db_timestamp_handles_both_sqlite_formats():
    # Bug found live: archive.last_archive_at (declared datetime) was assigned the raw
    # DB string, causing a pydantic serialization warning AND a would-be .isoformat()
    # crash in the HA push loop. The parser must accept both SQLite shapes.
    from datetime import datetime, timezone
    from backend.routers.status import _parse_db_timestamp

    # CURRENT_TIMESTAMP form: space-separated, naive
    naive = _parse_db_timestamp("2026-08-06 16:23:55")
    assert isinstance(naive, datetime)
    assert (naive.year, naive.month, naive.day, naive.hour, naive.minute, naive.second) == (2026, 8, 6, 16, 23, 55)

    # Python ISO form: 'T' separator, microseconds, tz-aware
    iso = _parse_db_timestamp("2026-08-06T16:22:28.104994+00:00")
    assert isinstance(iso, datetime)
    assert iso.tzinfo is not None
    assert iso.isoformat() == "2026-08-06T16:22:28.104994+00:00"  # .isoformat() must not raise

    # Passthrough + None + garbage
    dt = datetime(2026, 1, 1, tzinfo=timezone.utc)
    assert _parse_db_timestamp(dt) is dt
    assert _parse_db_timestamp(None) is None
    assert _parse_db_timestamp("not a date") is None
