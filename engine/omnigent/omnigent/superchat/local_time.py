"""Per-turn local date/time line for a superside-chat session.

The model has no clock of its own, and the framework's other date stamps are
UTC. The runner prefixes each superside-chat turn with this one line, rendered
in the owner's preference timezone (``/v1/me/proactivity``).
"""

from __future__ import annotations

from datetime import UTC, datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


def local_time_block(timezone: str | None, *, now: datetime | None = None) -> str:
    """Render the person's current local time, e.g.
    ``[Current local time for the person: Sunday, October 4, 2026, 9:12 AM
    (America/Toronto, UTC-04:00)]``.

    :param timezone: IANA zone name; unknown or empty falls back to UTC.
    :param now: Instant to render (tests); defaults to the current time.
    """
    instant = now or datetime.now(UTC)
    try:
        zone = ZoneInfo(timezone) if timezone else ZoneInfo("UTC")
    except (ZoneInfoNotFoundError, ValueError):
        zone = ZoneInfo("UTC")
    local = instant.astimezone(zone)
    offset = local.strftime("%z")
    sign = "\u2212" if offset.startswith("-") else "+"
    clock = f"{local:%A, %B} {local.day}, {local.year}, {local.hour % 12 or 12}:{local:%M %p}"
    return (
        f"[Current local time for the person: {clock} "
        f"({zone.key}, UTC{sign}{offset[1:3]}:{offset[3:5]})]"
    )
