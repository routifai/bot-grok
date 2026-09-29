"""SQLAlchemy-backed feed store."""

from __future__ import annotations

import base64
import json

from sqlalchemy import asc, delete, desc, func, or_, select
from sqlalchemy.orm import Session

from omnigent.db.db_models import current_workspace_id
from omnigent.db.utils import (
    get_or_create_engine,
    make_named_managed_session_maker,
    now_epoch,
    run_write_transaction,
)
from omnigent.errors import ErrorCode, OmnigentError
from omnigent.nova._shared import new_id
from omnigent.nova.feed.entities import FeedPost, FollowedTopic, Idea, IdeaDraft, PostKind
from omnigent.nova.feed.store import POST_PAGE_SIZE, FeedStore, PostPage
from omnigent.nova.feed.tables import (
    POST_KIND_CODES,
    POST_KIND_NAMES,
    SqlFeedIdea,
    SqlFeedPost,
    SqlFeedTopic,
)

_CURSOR_PREFIX = "v1."


def _encode_cursor(created_at: int, post_id: str) -> str:
    """Opaque keyset cursor over ``(created_at, id)``, the page boundary for `list_posts`."""
    payload = json.dumps({"created_at": created_at, "id": post_id}, separators=(",", ":"))
    return _CURSOR_PREFIX + base64.urlsafe_b64encode(payload.encode("utf-8")).decode("ascii")


def _decode_cursor(cursor: str) -> tuple[int, str]:
    """Inverse of :func:`_encode_cursor`.

    :raises OmnigentError: ``INVALID_INPUT`` if the cursor is malformed.
    """
    if not cursor.startswith(_CURSOR_PREFIX):
        raise OmnigentError("Invalid feed cursor", code=ErrorCode.INVALID_INPUT)
    try:
        raw = base64.urlsafe_b64decode(cursor[len(_CURSOR_PREFIX) :]).decode("utf-8")
        decoded = json.loads(raw)
        return int(decoded["created_at"]), str(decoded["id"])
    except (ValueError, KeyError, TypeError) as exc:
        raise OmnigentError("Invalid feed cursor", code=ErrorCode.INVALID_INPUT) from exc


def _post_to_entity(row: SqlFeedPost) -> FeedPost:
    return FeedPost(
        id=row.id,
        user_id=row.user_id,
        kind=POST_KIND_NAMES[row.kind],  # type: ignore[arg-type]
        title=row.title,
        body=row.body,
        goal_id=row.goal_id,
        source_url=row.source_url,
        created_at=row.created_at,
    )


def _topic_to_entity(row: SqlFeedTopic) -> FollowedTopic:
    return FollowedTopic(
        id=row.id, user_id=row.user_id, topic=row.topic, created_at=row.created_at
    )


def _idea_to_entity(row: SqlFeedIdea) -> Idea:
    return Idea(
        id=row.id,
        user_id=row.user_id,
        text=row.text,
        area=row.area,
        detail=row.detail,
        illustration=row.illustration,
        created_at=row.created_at,
    )


class SqlAlchemyFeedStore(FeedStore):
    """SQLAlchemy-backed implementation of :class:`FeedStore`.

    Every query is scoped by ``workspace_id`` (tenant partition, read from
    :func:`current_workspace_id`) and ``user_id`` (the feed is owner-private).
    """

    def __init__(self, storage_location: str) -> None:
        """:param storage_location: SQLAlchemy database URI, e.g. ``"sqlite:///chat.db"``."""
        super().__init__(storage_location)
        self._engine = get_or_create_engine(storage_location)
        self._session = make_named_managed_session_maker(
            self._engine, query_name_prefix="omnigent.nova.feed_store"
        )
        self._session_immediate = make_named_managed_session_maker(
            self._engine, query_name_prefix="omnigent.nova.feed_store", immediate=True
        )

    # ── posts ────────────────────────────────────────────────────────────

    def create_post(
        self,
        post_id: str,
        *,
        user_id: str | None,
        kind: PostKind,
        title: str,
        body: str,
        goal_id: str | None = None,
        source_url: str | None = None,
    ) -> FeedPost:
        """Create one post."""
        created_at = now_epoch()

        def write(session: Session) -> FeedPost:
            row = SqlFeedPost(
                workspace_id=current_workspace_id(),
                id=post_id,
                user_id=user_id,
                kind=POST_KIND_CODES[kind],
                title=title,
                body=body,
                goal_id=goal_id,
                source_url=source_url,
                created_at=created_at,
            )
            session.add(row)
            session.flush()
            return _post_to_entity(row)

        return run_write_transaction(self._session_immediate, "insert_feed_post", write)

    def list_posts(
        self,
        *,
        user_id: str | None,
        cursor: str | None = None,
        limit: int = POST_PAGE_SIZE,
    ) -> PostPage:
        """List an owner's posts, newest first, by keyset cursor over ``(created_at, id)``."""
        after = _decode_cursor(cursor) if cursor else None
        with self._session("list_feed_posts") as session:
            stmt = select(SqlFeedPost).where(
                SqlFeedPost.workspace_id == current_workspace_id(),
                SqlFeedPost.user_id == user_id,
            )
            if after is not None:
                after_created_at, after_id = after
                stmt = stmt.where(
                    or_(
                        SqlFeedPost.created_at < after_created_at,
                        (SqlFeedPost.created_at == after_created_at) & (SqlFeedPost.id < after_id),
                    )
                )
            stmt = stmt.order_by(
                desc(SqlFeedPost.created_at), desc(SqlFeedPost.id)
            ).limit(limit + 1)
            rows = session.execute(stmt).scalars().all()
            has_more = len(rows) > limit
            page = rows[:limit] if has_more else rows
            next_cursor = (
                _encode_cursor(page[-1].created_at, page[-1].id) if has_more and page else None
            )
            return PostPage(posts=[_post_to_entity(r) for r in page], next_cursor=next_cursor)

    # ── followed topics ─────────────────────────────────────────────────

    def list_topics(self, *, user_id: str | None) -> list[FollowedTopic]:
        """List an owner's followed topics, oldest-followed first."""
        with self._session("list_feed_topics") as session:
            stmt = (
                select(SqlFeedTopic)
                .where(
                    SqlFeedTopic.workspace_id == current_workspace_id(),
                    SqlFeedTopic.user_id == user_id,
                )
                .order_by(asc(SqlFeedTopic.created_at), asc(SqlFeedTopic.id))
            )
            return [_topic_to_entity(r) for r in session.execute(stmt).scalars().all()]

    def count_topics(self, *, user_id: str | None) -> int:
        """Count an owner's followed topics."""
        with self._session("count_feed_topics") as session:
            stmt = (
                select(func.count())
                .select_from(SqlFeedTopic)
                .where(
                    SqlFeedTopic.workspace_id == current_workspace_id(),
                    SqlFeedTopic.user_id == user_id,
                )
            )
            return session.execute(stmt).scalar_one()

    def get_topic_by_name(self, *, user_id: str | None, topic: str) -> FollowedTopic | None:
        """Find an owner's existing topic by exact text."""
        with self._session("get_feed_topic_by_name") as session:
            stmt = select(SqlFeedTopic).where(
                SqlFeedTopic.workspace_id == current_workspace_id(),
                SqlFeedTopic.user_id == user_id,
                SqlFeedTopic.topic == topic,
            )
            row = session.execute(stmt).scalars().first()
            return _topic_to_entity(row) if row else None

    def create_topic(self, topic_id: str, *, user_id: str | None, topic: str) -> FollowedTopic:
        """Insert a new followed topic."""
        created_at = now_epoch()

        def write(session: Session) -> FollowedTopic:
            row = SqlFeedTopic(
                workspace_id=current_workspace_id(),
                id=topic_id,
                user_id=user_id,
                topic=topic,
                created_at=created_at,
            )
            session.add(row)
            session.flush()
            return _topic_to_entity(row)

        return run_write_transaction(self._session_immediate, "insert_feed_topic", write)

    def get_topic(self, topic_id: str) -> FollowedTopic | None:
        """Return a topic by id regardless of owner."""
        with self._session("get_feed_topic") as session:
            row = session.get(SqlFeedTopic, (current_workspace_id(), topic_id))
            return _topic_to_entity(row) if row else None

    def delete_topic(self, topic_id: str, *, user_id: str | None) -> bool:
        """Unfollow a topic by id. Idempotent."""

        def write(session: Session) -> bool:
            row = session.get(SqlFeedTopic, (current_workspace_id(), topic_id))
            if row is None or row.user_id != user_id:
                return False
            session.delete(row)
            return True

        return run_write_transaction(self._session_immediate, "delete_feed_topic", write)

    # ── ideas ────────────────────────────────────────────────────────────

    def list_ideas(self, *, user_id: str | None) -> list[Idea]:
        """List an owner's ideas in suggested order."""
        with self._session("list_feed_ideas") as session:
            stmt = (
                select(SqlFeedIdea)
                .where(
                    SqlFeedIdea.workspace_id == current_workspace_id(),
                    SqlFeedIdea.user_id == user_id,
                )
                .order_by(asc(SqlFeedIdea.created_at), asc(SqlFeedIdea.id))
            )
            return [_idea_to_entity(r) for r in session.execute(stmt).scalars().all()]

    def replace_ideas(self, *, user_id: str | None, drafts: list[IdeaDraft]) -> list[Idea]:
        """Replace every one of an owner's ideas with a fresh batch, atomically.

        Per-row ``created_at`` offsets (seconds) preserve the model's
        suggested order, mirroring the TypeScript prototype's per-row
        millisecond offsets — there is no separate ordering column.
        """
        base = now_epoch()
        workspace_id = current_workspace_id()

        def write(session: Session) -> list[Idea]:
            session.execute(
                delete(SqlFeedIdea).where(
                    SqlFeedIdea.workspace_id == workspace_id, SqlFeedIdea.user_id == user_id
                )
            )
            rows = [
                SqlFeedIdea(
                    workspace_id=workspace_id,
                    id=new_id(),
                    user_id=user_id,
                    text=draft.text,
                    area=draft.area,
                    detail=draft.detail,
                    illustration=draft.illustration,
                    created_at=base + index,
                )
                for index, draft in enumerate(drafts)
            ]
            session.add_all(rows)
            session.flush()
            return [_idea_to_entity(r) for r in rows]

        return run_write_transaction(self._session_immediate, "replace_feed_ideas", write)
