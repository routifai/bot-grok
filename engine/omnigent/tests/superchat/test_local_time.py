from datetime import UTC, datetime

from omnigent.superchat.local_time import local_time_block

_NOW = datetime(2026, 10, 4, 13, 12, tzinfo=UTC)


def test_renders_in_owner_zone() -> None:
    assert local_time_block("America/Toronto", now=_NOW) == (
        "[Current local time for the person: 2026-10-04 09:12 (America/Toronto)]"
    )


def test_unknown_zone_falls_back_to_utc() -> None:
    assert "13:12 (UTC)" in local_time_block("Nope/Zone", now=_NOW)
    assert "(UTC)" in local_time_block(None, now=_NOW)
