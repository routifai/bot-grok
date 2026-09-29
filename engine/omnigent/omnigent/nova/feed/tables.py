"""SQLAlchemy models for the feed primitive's three tables.

Follows ``docs/DATABASE_BEST_PRACTICES.md``: ``workspace_id`` leads every
primary key, ids are ``Uuid16`` (16 raw bytes), no database foreign keys
(relationships to Goals/topics are maintained by the application), and every
column carries an explicit size bound.
"""

from __future__ import annotations

from sqlalchemy import BigInteger, CheckConstraint, Index, Integer, PrimaryKeyConstraint, String
from sqlalchemy.orm import Mapped, mapped_column

from omnigent.db.db_models import OmnigentBase, Uuid16, current_workspace_id

# Post.kind stored as a compact int code (local to this table, not
# omnigent/db/enum_codecs.py — this primitive owns its own small vocabulary).
# Codes are stable and append-only, same convention as the shared codecs.
POST_KIND_CODES: dict[str, int] = {"goal_report": 1, "topic": 2}
POST_KIND_NAMES: dict[int, str] = {code: name for name, code in POST_KIND_CODES.items()}

# Bounds mirror the TypeScript prototype's limits (feed-tools.ts, ideas.ts) —
# generous for their content, comfortably under the 16 KiB column cap.
_POST_TITLE_MAX = 200
_POST_BODY_MAX = 2_000
_SOURCE_URL_MAX = 2_048
_TOPIC_MAX = 200
_IDEA_TEXT_MAX = 160
_IDEA_AREA_MAX = 24
_IDEA_DETAIL_MAX = 320
_IDEA_ILLUSTRATION_MAX = 64


class SqlFeedPost(OmnigentBase):
    """One row per Feed post: a Goal report or a Followed-topic finding.

    :param workspace_id: Tenant partition; leads the primary key.
    :param id: Uuid16 primary key.
    :param user_id: Owning person, or ``None`` in single-user mode.
    :param kind: :data:`POST_KIND_CODES` code.
    :param title: Short headline, bounded to ``_POST_TITLE_MAX``.
    :param body: One-to-a-few-sentence body, bounded to ``_POST_BODY_MAX``.
    :param goal_id: The Goal this reports on (``kind=goal_report``), else
        ``None``. No DB foreign key (Rule R032 — see ``docs/DATABASE_BEST_PRACTICES.md``).
    :param source_url: The http(s) source a topic finding cites, else ``None``.
    :param created_at: Unix epoch seconds.
    """

    __tablename__ = "nova_feed_posts"

    workspace_id: Mapped[int] = mapped_column(
        BigInteger,
        primary_key=True,
        nullable=False,
        server_default="0",
        default=current_workspace_id,
    )
    id: Mapped[str] = mapped_column(Uuid16(), primary_key=True)
    user_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    kind: Mapped[int] = mapped_column(Integer, nullable=False)
    title: Mapped[str] = mapped_column(String(_POST_TITLE_MAX), nullable=False)
    body: Mapped[str] = mapped_column(String(_POST_BODY_MAX), nullable=False)
    goal_id: Mapped[str | None] = mapped_column(Uuid16(), nullable=True)
    source_url: Mapped[str | None] = mapped_column(String(_SOURCE_URL_MAX), nullable=True)
    created_at: Mapped[int] = mapped_column(Integer, nullable=False)

    __table_args__ = (
        CheckConstraint(
            f"kind IN ({', '.join(str(code) for code in POST_KIND_CODES.values())})",
            name="ck_nova_feed_posts_kind",
        ),
        PrimaryKeyConstraint("workspace_id", "id"),
        # "list my posts, newest first": an ascending index traversed backward
        # (ORDER BY created_at DESC, id DESC) per the no-descending-index rule.
        # (created_at, id) also gives the keyset-pagination cursor its tie-breaker.
        Index(
            "ix_nova_feed_posts_user_id",
            "workspace_id",
            "user_id",
            "created_at",
            "id",
        ),
    )


class SqlFeedTopic(OmnigentBase):
    """One row per topic the person asked Nova to follow.

    :param workspace_id: Tenant partition; leads the primary key.
    :param id: Uuid16 primary key.
    :param user_id: Owning person, or ``None`` in single-user mode.
    :param topic: The followed subject, bounded to ``_TOPIC_MAX``.
    :param created_at: Unix epoch seconds; topics list oldest-followed first.
    """

    __tablename__ = "nova_feed_topics"

    workspace_id: Mapped[int] = mapped_column(
        BigInteger,
        primary_key=True,
        nullable=False,
        server_default="0",
        default=current_workspace_id,
    )
    id: Mapped[str] = mapped_column(Uuid16(), primary_key=True)
    user_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    topic: Mapped[str] = mapped_column(String(_TOPIC_MAX), nullable=False)
    created_at: Mapped[int] = mapped_column(Integer, nullable=False)

    __table_args__ = (
        PrimaryKeyConstraint("workspace_id", "id"),
        # No unique index on (workspace_id, user_id, topic): dedupe is a
        # store-level check (mirrors SqlProject's per-owner name uniqueness —
        # NULL user_id in single-user mode makes a DB unique constraint
        # unreliable, since SQL treats NULLs as distinct). This index serves
        # both the listing and the dedupe/20-topic-cap checks.
        Index(
            "ix_nova_feed_topics_user_id",
            "workspace_id",
            "user_id",
            "created_at",
            "id",
        ),
    )


class SqlFeedIdea(OmnigentBase):
    """One row per suggestion of something the person could ask Nova next.

    Always replaced wholesale on refresh (``service.replace_ideas``).

    :param workspace_id: Tenant partition; leads the primary key.
    :param id: Uuid16 primary key.
    :param user_id: Owning person, or ``None`` in single-user mode.
    :param text: Short first-person title, bounded to ``_IDEA_TEXT_MAX``.
    :param area: One-word grouping label, bounded to ``_IDEA_AREA_MAX``.
    :param detail: 1-3 sentence explanation, or ``None``.
    :param illustration: Optional bundled illustration key.
    :param created_at: Unix epoch seconds (offset per row to preserve the
        model's suggested order within one replace).
    """

    __tablename__ = "nova_feed_ideas"

    workspace_id: Mapped[int] = mapped_column(
        BigInteger,
        primary_key=True,
        nullable=False,
        server_default="0",
        default=current_workspace_id,
    )
    id: Mapped[str] = mapped_column(Uuid16(), primary_key=True)
    user_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    text: Mapped[str] = mapped_column(String(_IDEA_TEXT_MAX), nullable=False)
    area: Mapped[str] = mapped_column(String(_IDEA_AREA_MAX), nullable=False)
    detail: Mapped[str | None] = mapped_column(String(_IDEA_DETAIL_MAX), nullable=True)
    illustration: Mapped[str | None] = mapped_column(String(_IDEA_ILLUSTRATION_MAX), nullable=True)
    created_at: Mapped[int] = mapped_column(Integer, nullable=False)

    __table_args__ = (
        PrimaryKeyConstraint("workspace_id", "id"),
        Index(
            "ix_nova_feed_ideas_user_id",
            "workspace_id",
            "user_id",
            "created_at",
            "id",
        ),
    )
