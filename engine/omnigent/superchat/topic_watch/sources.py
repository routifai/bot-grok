"""Stage 2 of topic watch: the source adapters, read-only, one cursor per source per person.

Every source answers one call, ``changes_since(owner, cursor)``: the items that changed after
the cursor and the cursor to keep. A source that cannot be read raises
:class:`SourceUnavailable` with a short reason, which the run records; it never fails the run.

* ``files``: the person's Library, versions saved since the cursor. Versions the assistant
  saved, restores and the person's own edits come back marked ``from_self`` (noise: the
  Conversation already knows them); a live file refreshed from its sources is news.
* ``web``: only for topics that asked for it. The engine has no search service it can call
  (web search is a model's own tool inside a turn), so it reports ``no_search_service``.
* ``mail`` and ``calendar``: no connector lists changes since a time yet, so both report
  ``not_connected`` (ADR 0035, Consequences).
"""

from __future__ import annotations

import asyncio
import html
import logging
import re
import time
from collections.abc import Callable, Sequence
from typing import Any, Protocol

from omnigent.superchat.topic_watch.rules import MAX_EXCERPT_CHARS, Item, WatchedTopic

_logger = logging.getLogger(__name__)

#: How far back the first run of a source reads, and the oldest cursor any run honours.
FIRST_LOOKBACK_SECONDS = 24 * 3600
MAX_LOOKBACK_SECONDS = 7 * 24 * 3600
#: Versions one run reads from the Library (newest first beyond this are left for no one).
MAX_FILES_PER_RUN = 25
#: Bytes of a text file read for its excerpt.
MAX_FILE_BYTES = 64 * 1024
#: Version origins that are news to the person: a live file refreshed from its sources.
NEWS_ORIGINS = frozenset({"update"})
_TEXT_MIMES = ("text/", "application/json", "application/xml", "image/svg+xml")
_TAGS = re.compile(r"<(script|style)\b.*?</\1>|<[^>]+>", re.IGNORECASE | re.DOTALL)


class SourceUnavailable(Exception):
    """The source cannot be read for this person; ``reason`` is recorded on the run."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class Source(Protocol):
    """One source of changes.

    ``topics`` are the person's watched topics, for a source that reads per topic (the web).
    """

    name: str

    async def changes_since(
        self, owner: str, cursor: str | None, *, topics: Sequence[WatchedTopic] = ()
    ) -> tuple[list[Item], str]:
        """The items changed after *cursor* and the new cursor."""
        ...


def start_epoch(cursor: str | None, now: float) -> int:
    """The epoch-seconds cursor a time-based source reads from, clamped to the lookback."""
    try:
        since = int(cursor) if cursor is not None else int(now - FIRST_LOOKBACK_SECONDS)
    except ValueError:
        since = int(now - FIRST_LOOKBACK_SECONDS)
    return max(since, int(now - MAX_LOOKBACK_SECONDS))


def excerpt(text: str, *, markup: bool = False) -> str:
    """*text* as one excerpt: tags dropped for *markup*, whitespace collapsed, at most
    :data:`MAX_EXCERPT_CHARS` characters."""
    if markup:
        text = html.unescape(_TAGS.sub(" ", text))
    flat = " ".join(text.split())
    return flat if len(flat) <= MAX_EXCERPT_CHARS else flat[: MAX_EXCERPT_CHARS - 1] + "…"


class FilesSource:
    """The person's Library: file versions saved since the cursor (epoch seconds).

    :param versions_since: ``(user_id or None, since, limit) -> rows`` of the versions saved
        after *since*, oldest first, each a mapping with the ``artifacts`` columns.
    :param read_blob: ``blob_key -> bytes`` of one version, or ``None`` without a blob store.
    """

    name = "files"

    def __init__(
        self,
        versions_since: Callable[[str | None, int, int], list[dict[str, Any]]],
        read_blob: Callable[[str], bytes] | None,
    ) -> None:
        self._versions_since = versions_since
        self._read_blob = read_blob

    async def changes_since(
        self, owner: str, cursor: str | None, *, topics: Sequence[WatchedTopic] = ()
    ) -> tuple[list[Item], str]:
        """Versions after *cursor*; the new cursor is the newest version read."""
        del topics  # the Library is read whole, for every topic
        from omnigent.server.auth import RESERVED_USER_LOCAL

        now = time.time()
        since = start_epoch(cursor, now)
        user_id = None if owner == RESERVED_USER_LOCAL else owner
        rows = await asyncio.to_thread(self._versions_since, user_id, since, MAX_FILES_PER_RUN)
        items = [await asyncio.to_thread(self._item, row) for row in rows]
        newest = max((int(row["created_at"]) for row in rows), default=since)
        return items, str(newest)

    def _item(self, row: dict[str, Any]) -> Item:
        group = row.get("group_id") or row["id"]
        news = row.get("origin") in NEWS_ORIGINS
        text = self._text(row) if news else ""
        return Item(
            source=self.name,
            id=row["id"],
            title=row.get("title") or row["name"],
            text_excerpt=text,
            at=int(row["created_at"]),
            thread_ref=group,
            refs=tuple(r for r in (row["name"], row.get("source_path")) if r),
            from_self=not news,
        )

    def _text(self, row: dict[str, Any]) -> str:
        """The version's text as an excerpt; empty for a binary file or an unreadable blob."""
        mime = str(row.get("mime") or "")
        if self._read_blob is None or not mime.startswith(_TEXT_MIMES):
            return ""
        try:
            data = self._read_blob(row["blob_key"])[:MAX_FILE_BYTES]
        except Exception:  # the title still matches; the text is a bonus
            _logger.warning("topic watch: could not read file %s", row["id"], exc_info=True)
            return ""
        return excerpt(data.decode("utf-8", "replace"), markup="html" in mime or "xml" in mime)


class WebSource:
    """The web, for topics marked as needing it; the engine has no search service to call."""

    name = "web"

    async def changes_since(
        self, owner: str, cursor: str | None, *, topics: Sequence[WatchedTopic] = ()
    ) -> tuple[list[Item], str]:
        """Nothing to read without topics that ask for the web; else no service to read it."""
        del owner, cursor
        if not any(t.web for t in topics):
            raise SourceUnavailable("not_needed")
        raise SourceUnavailable("no_search_service")


class UnconnectedSource:
    """A source with no connector that lists changes since a time (mail, calendar)."""

    def __init__(self, name: str) -> None:
        self.name = name

    async def changes_since(
        self, owner: str, cursor: str | None, *, topics: Sequence[WatchedTopic] = ()
    ) -> tuple[list[Item], str]:
        """Always unavailable: ``not_connected``."""
        del owner, cursor, topics
        raise SourceUnavailable("not_connected")
