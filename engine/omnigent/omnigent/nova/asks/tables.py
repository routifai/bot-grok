"""SQLAlchemy model for the ``nova_asks`` table.

One row per Ask. Small, bounded columns throughout (``docs/DATABASE_BEST_PRACTICES.md``):
the free-text fields are capped well under the 16 KiB per-value limit, and
``actions`` — at most four short options — is a plain bounded string rather
than a child table, since it is never filtered in SQL and always read and
written whole with the row.
"""

from __future__ import annotations

from sqlalchemy import BigInteger, Index, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from omnigent.db.db_models import OmnigentBase, Uuid16, current_workspace_id


class SqlNovaAsk(OmnigentBase):
    """One row of ``nova_asks``.

    :param workspace_id: Tenant partition; leads the primary key.
    :param id: Uuid16 primary key (bare 32-char hex in Python).
    :param user_id: The person this Ask is for.
    :param session_id: The Omnigent session this Ask concerns, or ``NULL``.
    :param kind: One of :class:`~omnigent.nova.asks.entities.AskKind`.
    :param text: The question or approval prompt.
    :param detail: Optional longer context, or ``NULL``.
    :param actions_json: Compact JSON array of ``{"id", "label"}`` objects
        (at most four), or ``NULL`` for a free-text question.
    :param status: One of :class:`~omnigent.nova.asks.entities.AskStatus`.
    :param answer: The person's answer, or ``NULL`` while open.
    :param elicitation_id: The Omnigent elicitation this Ask mirrors, or
        ``NULL``. Unique per workspace so a republished elicitation event
        never creates a second Ask for the same prompt.
    :param goal_id: The Goal this Ask concerns, or ``NULL``.
    :param task_id: The Goal task this Ask concerns, or ``NULL``.
    :param created_at: Unix epoch seconds.
    :param answered_at: Unix epoch seconds the person answered, or ``NULL``.
    """

    __tablename__ = "nova_asks"

    workspace_id: Mapped[int] = mapped_column(
        BigInteger,
        primary_key=True,
        nullable=False,
        server_default="0",
        default=current_workspace_id,
    )
    id: Mapped[str] = mapped_column(Uuid16(), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(128), nullable=False)
    session_id: Mapped[str | None] = mapped_column(Uuid16(), nullable=True)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    text: Mapped[str] = mapped_column(String(1000), nullable=False)
    detail: Mapped[str | None] = mapped_column(String(4000), nullable=True)
    actions_json: Mapped[str | None] = mapped_column(String(2000), nullable=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    answer: Mapped[str | None] = mapped_column(String(4000), nullable=True)
    # ``elicit_<32 hex>`` (see orchestration.py's ``secrets.token_hex(16)``
    # mint) — longer than a bare Uuid16, so a plain bounded string.
    elicitation_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    goal_id: Mapped[str | None] = mapped_column(Uuid16(), nullable=True)
    task_id: Mapped[str | None] = mapped_column(Uuid16(), nullable=True)
    created_at: Mapped[int] = mapped_column(Integer, nullable=False)
    answered_at: Mapped[int | None] = mapped_column(Integer, nullable=True)

    __table_args__ = (
        # "Waiting on you": open asks for a person, newest first. created_at
        # and id trail so the ORDER BY is served by the index (backward scan,
        # no filesort) rather than a descending index (Rule: no descending
        # indexes).
        Index(
            "ix_nova_asks_open",
            "workspace_id",
            "user_id",
            "status",
            "created_at",
            "id",
        ),
        # expire_for_session: bulk-close the open asks tied to one session.
        Index("ix_nova_asks_session", "workspace_id", "session_id", "status"),
        # Elicitation bridge dedup: a republished response.elicitation_request
        # (e.g. a harness reconnect replaying the same event) must not mint a
        # second Ask. NULLs (the common case — most Asks have no elicitation)
        # are distinct from one another under a unique index on every
        # supported engine, so this never blocks ordinary Asks.
        Index(
            "ix_nova_asks_elicitation",
            "workspace_id",
            "elicitation_id",
            unique=True,
        ),
    )
