"""SQLAlchemy models for Goals, their Tasks, and their Proposals.

Three tables, all on :class:`~omnigent.db.db_models.OmnigentBase`:

* ``nova_goals`` — one row per Goal.
* ``nova_goal_tasks`` — a Goal's current plan; replaced wholesale when a
  Proposal is accepted (see ``service.accept_proposal``).
* ``nova_goal_proposals`` — a Goal's Proposal history, including decided
  ones; at most one row per Goal has ``status = OPEN`` at any time.

Every table leads its primary key with ``workspace_id`` and carries no
database foreign keys, per ``docs/DATABASE_BEST_PRACTICES.md``. Status enums
are stored as small integer codes (below) rather than strings, kept private
to this primitive rather than added to the shared
``omnigent/db/enum_codecs.py`` table, since Goals owns its own schema.
"""

from __future__ import annotations

from sqlalchemy import BigInteger, CheckConstraint, Index, Integer, SmallInteger, String
from sqlalchemy.orm import Mapped, mapped_column

from omnigent.db.compression import CompressedText
from omnigent.db.db_models import OmnigentBase, Uuid16, current_workspace_id

# Stable int codes, append-only (never renumber or reuse a shipped code).
GOAL_STATUS_CODE: dict[str, int] = {"active": 1, "paused": 2, "cancelled": 3, "done": 4}
TASK_STATUS_CODE: dict[str, int] = {
    "pending": 1,
    "in_progress": 2,
    "done": 3,
    "blocked": 4,
    "skipped": 5,
}
PROPOSAL_STATUS_CODE: dict[str, int] = {
    "open": 1,
    "accepted": 2,
    "dismissed": 3,
    "withdrawn": 4,
}

# Column length bounds. Kept next to the tables they constrain; service.py
# enforces the same limits before a write reaches the store.
TITLE_MAX_LEN = 200
DUE_DATE_LEN = 10  # "YYYY-MM-DD"


class SqlGoal(OmnigentBase):
    """One row per Goal.

    :param id: Uuid16 primary key.
    :param user_id: The owning person; Goals are never shared.
    :param title: Short name for the outcome.
    :param description: Longer free text, opaque to SQL — stored compressed.
    :param due_date: Calendar date string ``"YYYY-MM-DD"``, or ``None``.
    :param check_in_crons: JSON array of cron strings, stored compressed
        (small and never queried in SQL).
    :param timezone: IANA timezone for check-ins and quiet hours.
    :param status: :data:`GOAL_STATUS_CODE`.
    :param session_id: The Goal's own background session, or ``None``.
    :param created_at: Unix epoch seconds.
    :param updated_at: Unix epoch seconds of the last change, or ``None``.
    """

    __tablename__ = "nova_goals"

    workspace_id: Mapped[int] = mapped_column(
        BigInteger,
        primary_key=True,
        nullable=False,
        server_default="0",
        default=current_workspace_id,
    )
    id: Mapped[str] = mapped_column(Uuid16, primary_key=True)
    user_id: Mapped[str] = mapped_column(String(128), nullable=False)
    title: Mapped[str] = mapped_column(String(TITLE_MAX_LEN), nullable=False)
    description: Mapped[str] = mapped_column(CompressedText, nullable=False)
    due_date: Mapped[str | None] = mapped_column(String(DUE_DATE_LEN), nullable=True)
    check_in_crons: Mapped[str] = mapped_column(CompressedText, nullable=False)
    timezone: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    session_id: Mapped[str | None] = mapped_column(Uuid16, nullable=True)
    created_at: Mapped[int] = mapped_column(Integer, nullable=False)
    updated_at: Mapped[int | None] = mapped_column(Integer, nullable=True)

    __table_args__ = (
        CheckConstraint("status IN (1, 2, 3, 4)", name="ck_nova_goals_status"),
        # The one query this table serves today: "this person's Goals, oldest
        # first" (GET /v1/nova/goals).
        Index("ix_nova_goals_user", "workspace_id", "user_id", "created_at", "id"),
    )


class SqlGoalTask(OmnigentBase):
    """One step of a Goal's current plan.

    Replaced wholesale on ``accept_proposal`` (rows not in the accepted plan
    are deleted; kept ones are re-numbered in place; new ones are inserted)
    — see ``service.accept_proposal``.

    :param id: Uuid16 primary key.
    :param goal_id: The owning Goal (relates to ``nova_goals.id``; no
        database foreign key, per schema rule R032).
    :param idx: Position in the plan, 0-based.
    :param title: Short description of the step.
    :param status: :data:`TASK_STATUS_CODE`.
    :param note: Free text, opaque to SQL — stored compressed.
    :param created_at: Unix epoch seconds.
    :param updated_at: Unix epoch seconds of the last change (a status/note
        edit, or a reorder on ``accept_proposal``), or ``None``.
    """

    __tablename__ = "nova_goal_tasks"

    workspace_id: Mapped[int] = mapped_column(
        BigInteger,
        primary_key=True,
        nullable=False,
        server_default="0",
        default=current_workspace_id,
    )
    id: Mapped[str] = mapped_column(Uuid16, primary_key=True)
    goal_id: Mapped[str] = mapped_column(Uuid16, nullable=False)
    idx: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    title: Mapped[str] = mapped_column(String(TITLE_MAX_LEN), nullable=False)
    status: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    note: Mapped[str] = mapped_column(CompressedText, nullable=False)
    created_at: Mapped[int] = mapped_column(Integer, nullable=False)
    updated_at: Mapped[int | None] = mapped_column(Integer, nullable=True)

    __table_args__ = (
        CheckConstraint("status IN (1, 2, 3, 4, 5)", name="ck_nova_goal_tasks_status"),
        # "This Goal's plan, in order" — the only read pattern.
        Index("ix_nova_goal_tasks_goal", "workspace_id", "goal_id", "idx", "id"),
    )


class SqlGoalProposal(OmnigentBase):
    """One Proposal — a plan for a Goal awaiting (or having received) a decision.

    :param id: Uuid16 primary key.
    :param goal_id: The owning Goal (relates to ``nova_goals.id``; no
        database foreign key, per schema rule R032).
    :param reason: Why this plan. Opaque to SQL — stored compressed.
    :param tasks: JSON array of ``{"title": ..., "keep_task_id": ...}``,
        stored compressed. Bounded by ``service.MAX_PROPOSAL_TASKS`` before
        it ever reaches this column.
    :param status: :data:`PROPOSAL_STATUS_CODE`.
    :param created_at: Unix epoch seconds.
    :param decided_at: Unix epoch seconds of accept/dismiss/withdrawal, or
        ``None`` while open.
    """

    __tablename__ = "nova_goal_proposals"

    workspace_id: Mapped[int] = mapped_column(
        BigInteger,
        primary_key=True,
        nullable=False,
        server_default="0",
        default=current_workspace_id,
    )
    id: Mapped[str] = mapped_column(Uuid16, primary_key=True)
    goal_id: Mapped[str] = mapped_column(Uuid16, nullable=False)
    reason: Mapped[str] = mapped_column(CompressedText, nullable=False)
    tasks: Mapped[str] = mapped_column(CompressedText, nullable=False)
    status: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    created_at: Mapped[int] = mapped_column(Integer, nullable=False)
    decided_at: Mapped[int | None] = mapped_column(Integer, nullable=True)

    __table_args__ = (
        CheckConstraint("status IN (1, 2, 3, 4)", name="ck_nova_goal_proposals_status"),
        # "This Goal's Proposals, newest first" — used to find the open one
        # and to render history. A Goal has very few Proposals ever, so this
        # scan is bounded regardless of ordering.
        Index("ix_nova_goal_proposals_goal", "workspace_id", "goal_id", "created_at", "id"),
    )
