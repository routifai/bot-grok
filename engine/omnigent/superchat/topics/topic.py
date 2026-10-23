"""Topics (ADR 0035): the record, and the code rules that clean what the notes Helper writes.

Pure: no store, no server. :func:`clean_update` validates and trims one ``topics_update`` entry
(it never asks the model to repair: what does not fit is cut or dropped), :func:`merge` applies
it to the stored topic (a field passed replaces the stored one, ``events`` are merged and
deduplicated, the newest :data:`MAX_EVENTS` kept, ``last_touched_at`` is the newest event).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any
from zoneinfo import ZoneInfo

COVERED_KINDS = ("Decided", "Made", "Found", "Asked")
OPEN_KINDS = ("Open", "Promised")
STATUSES = ("open", "closed")
SOURCE_KEYS = ("chats", "files", "emails")

MAX_KEY_CHARS = 64
MAX_TITLE_WORDS = 5
MAX_TITLE_CHARS = 80
MAX_LINE_CHARS = 240
MAX_ITEM_CHARS = 160
MAX_STARTER_CHARS = 140
MAX_COVERED = 6
MAX_OPEN = 4
MAX_STARTERS = 3
MAX_EVENTS = 12
MAX_SOURCE_COUNT = 9999
MAX_WATCH_PEOPLE = 12
MAX_WATCH_TERMS = 8
MAX_WATCH_REFS = 20
MAX_WATCH_CHARS = 120
#: Topics one ``topics_update`` call may write.
MAX_TOPICS_PER_CALL = 8
#: A topic untouched this long drops out of every list (it is kept).
WINDOW_DAYS = 7
#: An event dated further ahead than this is not a moment that happened; it is dropped.
_FUTURE_SLACK_SECONDS = 3600

_KEY_RE = re.compile(r"[^a-z0-9]+")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


@dataclass
class Topic:
    """
    One topic of an owner.

    :param owner: Owner identity (``"local"`` in single-user mode).
    :param key: Stable slug, e.g. ``"polaris-launch"`` (the working list's ``t-`` tag when one
        exists).
    :param title: 2 to 5 words in the person's terms.
    :param left_off: One sentence: where it stands now.
    :param covered: ``[{date, kind, text, file?}]``, ``kind`` one of :data:`COVERED_KINDS`.
    :param open: ``[{kind, text}]``, ``kind`` one of :data:`OPEN_KINDS`.
    :param starters: Next requests in the person's voice, never sent on their own.
    :param events: ``[{at, line}]`` newest first, ``at`` epoch seconds.
    :param sources: ``{chats, files, emails}`` counts.
    :param watch: ``{people, terms, refs, web}`` for topic watch (stored; read by the next wave).
    :param status: ``"open"`` or ``"closed"``.
    :param since: The "New" line topic watch set, or ``""``.
    :param since_at: Epoch seconds ``since`` was set, or ``None``.
    :param last_touched_at: Epoch seconds of the newest event.
    """

    owner: str
    key: str
    title: str
    left_off: str = ""
    covered: list[dict[str, str]] = field(default_factory=list)
    open: list[dict[str, str]] = field(default_factory=list)
    starters: list[str] = field(default_factory=list)
    events: list[dict[str, Any]] = field(default_factory=list)
    sources: dict[str, int] = field(default_factory=dict)
    watch: dict[str, Any] = field(default_factory=dict)
    status: str = "open"
    since: str = ""
    since_at: int | None = None
    last_touched_at: int = 0
    created_at: int = 0
    updated_at: int = 0

    def body(self) -> dict[str, Any]:
        """The fields kept in the row's JSON ``body``."""
        return {
            "left_off": self.left_off,
            "covered": self.covered,
            "open": self.open,
            "starters": self.starters,
            "events": self.events,
            "sources": self.sources,
            "watch": self.watch,
            "since": self.since,
        }


def _line(value: object, limit: int) -> str:
    """One trimmed line of at most *limit* characters (``""`` for a non-string)."""
    if not isinstance(value, str):
        return ""
    text = " ".join(value.split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def clean_key(value: object) -> str:
    """A slug of lowercase letters, digits and hyphens, or ``""`` when nothing is left."""
    if not isinstance(value, str):
        return ""
    return _KEY_RE.sub("-", value.lower()).strip("-")[:MAX_KEY_CHARS].strip("-")


def clean_title(value: object) -> str:
    """At most :data:`MAX_TITLE_WORDS` words and :data:`MAX_TITLE_CHARS` characters."""
    words = _line(value, MAX_TITLE_CHARS * 2).split()[:MAX_TITLE_WORDS]
    return _line(" ".join(words), MAX_TITLE_CHARS)


def parse_at(value: object, zone: ZoneInfo, now: int) -> int | None:
    """Epoch seconds of an event time: epoch seconds, ``YYYY-MM-DD`` (noon) or ISO 8601.

    A time without an offset is the owner's local time. ``None`` when it does not parse or lies
    in the future.
    """
    at: int | None = None
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        at = int(value)
    elif isinstance(value, str) and value.strip():
        text = value.strip()
        try:
            if _DATE_RE.match(text):
                parsed = datetime.fromisoformat(text).replace(hour=12, tzinfo=zone)
            else:
                parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
                if parsed.tzinfo is None:
                    parsed = parsed.replace(tzinfo=zone)
        except ValueError:
            return None
        at = int(parsed.timestamp())
    if at is None or at <= 0 or at > now + _FUTURE_SLACK_SECONDS:
        return None
    return at


def _covered(raw: object) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for entry in raw if isinstance(raw, list) else []:
        if not isinstance(entry, dict) or entry.get("kind") not in COVERED_KINDS:
            continue
        text = _line(entry.get("text"), MAX_ITEM_CHARS)
        date = entry.get("date") if isinstance(entry.get("date"), str) else ""
        if not text or not _DATE_RE.match(date):
            continue
        item = {"date": date, "kind": entry["kind"], "text": text}
        file = _line(entry.get("file"), MAX_ITEM_CHARS)
        if file:
            item["file"] = file
        out.append(item)
    return out[:MAX_COVERED]


def _open(raw: object) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for entry in raw if isinstance(raw, list) else []:
        if not isinstance(entry, dict) or entry.get("kind") not in OPEN_KINDS:
            continue
        text = _line(entry.get("text"), MAX_ITEM_CHARS)
        if text:
            out.append({"kind": entry["kind"], "text": text})
    return out[:MAX_OPEN]


def _strings(raw: object, *, limit: int, chars: int) -> list[str]:
    out: list[str] = []
    for entry in raw if isinstance(raw, list) else []:
        text = _line(entry, chars)
        if text and text.lower() not in {s.lower() for s in out}:
            out.append(text)
    return out[:limit]


def _events(raw: object, zone: ZoneInfo, now: int) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for entry in raw if isinstance(raw, list) else []:
        if not isinstance(entry, dict):
            continue
        at = parse_at(entry.get("at"), zone, now)
        line = _line(entry.get("line"), MAX_ITEM_CHARS)
        if at is not None and line:
            out.append({"at": at, "line": line})
    return out


def _sources(raw: object) -> dict[str, int]:
    if not isinstance(raw, dict):
        return {}
    out: dict[str, int] = {}
    for key in SOURCE_KEYS:
        value = raw.get(key)
        if isinstance(value, int) and not isinstance(value, bool):
            out[key] = max(0, min(value, MAX_SOURCE_COUNT))
    return out


def _watch(raw: object) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    return {
        "people": _strings(raw.get("people"), limit=MAX_WATCH_PEOPLE, chars=MAX_WATCH_CHARS),
        "terms": _strings(raw.get("terms"), limit=MAX_WATCH_TERMS, chars=MAX_WATCH_CHARS),
        "refs": _strings(raw.get("refs"), limit=MAX_WATCH_REFS, chars=MAX_WATCH_CHARS * 2),
        "web": raw.get("web") is True,
    }


def clean_update(raw: object, zone: ZoneInfo, now: int) -> tuple[str, dict[str, Any]] | str:
    """One ``topics_update`` entry as ``(key, fields)``, or why it was dropped.

    Only the fields the entry passed (and that survived cleaning) are in ``fields``: a field
    left out keeps what is stored.

    :param raw: The entry as the model sent it.
    :param zone: The owner's zone, for event times without an offset.
    :param now: Epoch seconds now.
    :returns: ``(key, fields)``, or a short reason string.
    """
    if not isinstance(raw, dict):
        return "not an object"
    key = clean_key(raw.get("key"))
    if not key:
        return "missing key"
    fields: dict[str, Any] = {}
    if "title" in raw and (title := clean_title(raw["title"])):
        fields["title"] = title
    if "left_off" in raw and (left_off := _line(raw["left_off"], MAX_LINE_CHARS)):
        fields["left_off"] = left_off
    if "covered" in raw:
        fields["covered"] = _covered(raw["covered"])
    if "open" in raw:
        fields["open"] = _open(raw["open"])
    if "starters" in raw:
        fields["starters"] = _strings(raw["starters"], limit=MAX_STARTERS, chars=MAX_STARTER_CHARS)
    if "events" in raw:
        fields["events"] = _events(raw["events"], zone, now)
    if "sources" in raw:
        fields["sources"] = _sources(raw["sources"])
    if "watch" in raw and (watch := _watch(raw["watch"])) is not None:
        fields["watch"] = watch
    if raw.get("status") in STATUSES:
        fields["status"] = raw["status"]
    return key, fields


def _event_key(event: dict[str, Any]) -> tuple[str, str]:
    day = datetime.fromtimestamp(event["at"], UTC).date().isoformat()
    return day, " ".join(str(event["line"]).lower().split())


def merge_events(
    stored: list[dict[str, Any]], incoming: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Both lists, one entry per (day, line), newest first, at most :data:`MAX_EVENTS`."""
    seen: dict[tuple[str, str], dict[str, Any]] = {}
    for event in sorted([*stored, *incoming], key=lambda e: e["at"], reverse=True):
        seen.setdefault(_event_key(event), event)
    return list(seen.values())[:MAX_EVENTS]


def merge(topic: Topic, fields: dict[str, Any], now: int) -> Topic:
    """Apply cleaned *fields* to *topic* in place and return it."""
    for name in ("title", "left_off", "covered", "open", "starters", "sources", "watch", "status"):
        if name in fields:
            setattr(topic, name, fields[name])
    if "events" in fields:
        topic.events = merge_events(topic.events, fields["events"])
    newest = max((e["at"] for e in topic.events), default=0)
    if not newest:
        # No dated moment: the newest covered line's day, never the write time (a topic seeded
        # from last week must not read as touched today).
        utc = ZoneInfo("UTC")
        newest = max((parse_at(c.get("date"), utc, now) or 0 for c in topic.covered), default=0)
    topic.last_touched_at = newest or topic.last_touched_at or now
    topic.updated_at = now
    return topic
