"""Topic store: one row per owner per topic (owner-scoped), upserted by key.

Other capabilities read topics through two functions only, :func:`list_watched_topics` and
:func:`mark_topic_new`, which use the store the feature installed.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import desc, select
from sqlalchemy.orm import Session

from omnigent.db.db_models import SqlTopic, current_workspace_id
from omnigent.db.utils import (
    get_or_create_engine,
    make_named_managed_session_maker,
    now_epoch,
    run_write_transaction,
)
from omnigent.superchat.topics.topic import (
    MAX_ITEM_CHARS,
    MAX_TOPICS_PER_CALL,
    WINDOW_DAYS,
    Topic,
    clean_update,
    merge,
)

LOCAL_OWNER = "local"
_DAY = 86400


def _to_entity(row: SqlTopic) -> Topic:
    try:
        body = json.loads(row.body)
    except ValueError:
        body = {}
    if not isinstance(body, dict):
        body = {}
    return Topic(
        owner=row.owner,
        key=row.key,
        title=row.title,
        left_off=str(body.get("left_off") or ""),
        covered=list(body.get("covered") or []),
        open=list(body.get("open") or []),
        starters=list(body.get("starters") or []),
        events=list(body.get("events") or []),
        sources=dict(body.get("sources") or {}),
        watch=dict(body.get("watch") or {}),
        status=row.status,
        since=str(body.get("since") or ""),
        since_at=row.since_at,
        last_touched_at=row.last_touched_at,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _write_row(row: SqlTopic, topic: Topic) -> None:
    row.title = topic.title
    row.status = topic.status
    row.body = json.dumps(topic.body(), ensure_ascii=False)
    row.last_touched_at = topic.last_touched_at
    row.since_at = topic.since_at
    row.updated_at = topic.updated_at


class SqlAlchemyTopicStore:
    """SQLAlchemy-backed store for the ``topics`` table."""

    def __init__(self, storage_location: str) -> None:
        """
        :param storage_location: SQLAlchemy database URI, e.g. ``"sqlite:///chat.db"``.
        """
        self.storage_location = storage_location
        self._engine = get_or_create_engine(storage_location)
        self._session = make_named_managed_session_maker(
            self._engine, query_name_prefix="omnigent.topic_store"
        )
        self._session_immediate = make_named_managed_session_maker(
            self._engine, query_name_prefix="omnigent.topic_store", immediate=True
        )

    @staticmethod
    def owner_key(user_id: str | None) -> str:
        """The stored owner key for a user id (``None`` is single-user mode)."""
        return user_id or LOCAL_OWNER

    def get(self, owner: str, key: str) -> Topic | None:
        """The owner's topic, or ``None``."""
        with self._session("select_topic") as session:
            row = session.get(SqlTopic, (current_workspace_id(), owner, key))
            return _to_entity(row) if row else None

    def list_recent(
        self, owner: str, *, days: int = WINDOW_DAYS, now: int | None = None
    ) -> list[Topic]:
        """Open topics touched within *days* (at most :data:`WINDOW_DAYS`), newest first."""
        since = (now if now is not None else now_epoch()) - min(days, WINDOW_DAYS) * _DAY
        with self._session("list_topics") as session:
            stmt = (
                select(SqlTopic)
                .where(
                    SqlTopic.workspace_id == current_workspace_id(),
                    SqlTopic.owner == owner,
                    SqlTopic.status == "open",
                    SqlTopic.last_touched_at >= since,
                )
                .order_by(desc(SqlTopic.last_touched_at))
                .limit(100)
            )
            return [_to_entity(r) for r in session.execute(stmt).scalars().all()]

    def has_any(self, owner: str) -> bool:
        """Whether the owner has ever had a topic (closed and old ones count)."""
        with self._session("any_topic") as session:
            stmt = select(SqlTopic.key).where(
                SqlTopic.workspace_id == current_workspace_id(), SqlTopic.owner == owner
            )
            return session.execute(stmt.limit(1)).first() is not None

    def update(
        self, owner: str, entries: list[Any], *, zone: ZoneInfo, now: int | None = None
    ) -> dict[str, Any]:
        """Upsert ``topics_update`` entries by key, after cleaning them (:func:`clean_update`).

        A new topic needs a title; an entry that cannot be used is reported, never repaired.

        :returns: ``{"written": [{key, created}], "skipped": [{key?, reason}]}``.
        """
        instant = now if now is not None else now_epoch()
        written: list[dict[str, Any]] = []
        skipped: list[dict[str, Any]] = []
        if len(entries) > MAX_TOPICS_PER_CALL:
            skipped.append({"reason": f"only the first {MAX_TOPICS_PER_CALL} topics are kept"})
        cleaned: dict[str, dict[str, Any]] = {}
        for raw in entries[:MAX_TOPICS_PER_CALL]:
            result = clean_update(raw, zone, instant)
            if isinstance(result, str):
                key = raw.get("key") if isinstance(raw, dict) else None
                skipped.append(
                    {**({"key": key} if isinstance(key, str) else {}), "reason": result}
                )
                continue
            key, fields = result
            cleaned[key] = {**cleaned.get(key, {}), **fields}

        def write(session: Session) -> None:
            for key, fields in cleaned.items():
                row = session.get(SqlTopic, (current_workspace_id(), owner, key))
                if row is None:
                    if not fields.get("title"):
                        skipped.append({"key": key, "reason": "a new topic needs a title"})
                        continue
                    topic = merge(
                        Topic(owner=owner, key=key, title="", created_at=instant), fields, instant
                    )
                    row = SqlTopic(owner=owner, key=key, created_at=instant)
                    _write_row(row, topic)
                    session.add(row)
                    written.append({"key": key, "created": True})
                else:
                    _write_row(row, merge(_to_entity(row), fields, instant))
                    written.append({"key": key, "created": False})
            session.flush()

        run_write_transaction(self._session_immediate, "topics_update", write)
        return {"written": written, "skipped": skipped}

    def mark_new(self, owner: str, key: str, line: str, at: int) -> bool:
        """Set a topic's ``since`` ("New") line; ``False`` when there is no such topic."""
        text = " ".join(str(line).split())[:MAX_ITEM_CHARS]
        found = False

        def write(session: Session) -> None:
            nonlocal found
            row = session.get(SqlTopic, (current_workspace_id(), owner, key))
            if row is None:
                return
            topic = _to_entity(row)
            topic.since, topic.since_at, topic.updated_at = text, int(at), now_epoch()
            _write_row(row, topic)
            found = True

        run_write_transaction(self._session_immediate, "topic_mark_new", write)
        return found


#: The store :func:`install` set (the feature's ``install``); ``None`` before it ran.
_store: SqlAlchemyTopicStore | None = None


def install(store: SqlAlchemyTopicStore | None) -> None:
    """Set the store the module functions below use."""
    global _store
    _store = store


def list_watched_topics(owner: str) -> list[dict[str, Any]]:
    """Open topics touched within 7 days, for topic watch and the daily brief: key, title,
    left_off, open, watch, last_touched_at and the "New" line (since, since_at). Empty before the
    feature is installed."""
    if _store is None:
        return []
    return [
        {
            "key": t.key,
            "title": t.title,
            "left_off": t.left_off,
            "open": t.open,
            "watch": t.watch,
            "last_touched_at": t.last_touched_at,
            "since": t.since,
            "since_at": t.since_at,
        }
        for t in _store.list_recent(owner)
    ]


def mark_topic_new(owner: str, key: str, line: str, at: int) -> bool:
    """Set topic *key*'s "New" line (shown on Home for 48 hours); ``False`` when not found."""
    return _store.mark_new(owner, key, line, at) if _store is not None else False


def brief_lines(owner: str) -> str:
    """The owner's topics touched this week, one line each (key, title, last touched,
    ``left_off``) for the quiet brief; ``""`` when there are none."""
    lines = []
    for topic in _store.list_recent(owner) if _store is not None else []:
        touched = datetime.fromtimestamp(topic.last_touched_at, UTC).strftime("%Y-%m-%d")
        left_off = f": {topic.left_off}" if topic.left_off else ""
        lines.append(f"- `{topic.key}` {topic.title} (last touched {touched}){left_off}")
    return "\n".join(lines)
