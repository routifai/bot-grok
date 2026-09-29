"""Nova goals tables.

Owned by omnigent/nova/goals/ (see its README and ``tables.py``, the source of
truth this migration mirrors). Creates ``nova_goals``, ``nova_goal_tasks`` and
``nova_goal_proposals`` — all brand-new tables, so each carries the tenant
partition ``workspace_id`` as the leading primary-key member (matching every
table after ``r1a2b3c4d5e6``) and no database foreign keys (schema Rule R032):
the ``goal_id`` relationship between the three tables is enforced by
application code (``omnigent/nova/goals/sqlalchemy_store.py``), not the
database.

Status enums (``status`` on all three tables) are stored as ``SMALLINT``
codes rather than strings — see ``tables.py``'s ``GOAL_STATUS_CODE`` /
``TASK_STATUS_CODE`` / ``PROPOSAL_STATUS_CODE`` for the name<->code mapping,
kept private to this primitive rather than the shared
``omnigent/db/enum_codecs.py`` table.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from omnigent.db.db_models import Uuid16

revision: str = "nova03goals"
down_revision: str | None = "nova02episodes"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create the goals tables."""
    op.create_table(
        "nova_goals",
        sa.Column("workspace_id", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("id", Uuid16(), nullable=False),
        sa.Column("user_id", sa.String(128), nullable=False),
        sa.Column("title", sa.String(200), nullable=False),
        # Opaque free text, never SQL-queried — stored compressed (CompressedText → LargeBinary).
        sa.Column("description", sa.LargeBinary(), nullable=False),
        sa.Column("due_date", sa.String(10), nullable=True),
        # JSON array of cron strings, stored compressed (CompressedText → LargeBinary).
        sa.Column("check_in_crons", sa.LargeBinary(), nullable=False),
        sa.Column("timezone", sa.String(64), nullable=False),
        # GOAL_STATUS_CODE: active=1, paused=2, cancelled=3, done=4.
        sa.Column("status", sa.SmallInteger(), nullable=False),
        # Relates to conversations.id (String-keyed AP table); no DB FK.
        sa.Column("session_id", Uuid16(), nullable=True),
        sa.Column("created_at", sa.Integer(), nullable=False),
        sa.Column("updated_at", sa.Integer(), nullable=True),
        sa.CheckConstraint("status IN (1, 2, 3, 4)", name="ck_nova_goals_status"),
        sa.PrimaryKeyConstraint("workspace_id", "id"),
    )
    op.create_index(
        "ix_nova_goals_user",
        "nova_goals",
        ["workspace_id", "user_id", "created_at", "id"],
        unique=False,
    )

    op.create_table(
        "nova_goal_tasks",
        sa.Column("workspace_id", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("id", Uuid16(), nullable=False),
        # Relates to nova_goals.id; no DB FK (Rule R032).
        sa.Column("goal_id", Uuid16(), nullable=False),
        sa.Column("idx", sa.SmallInteger(), nullable=False),
        sa.Column("title", sa.String(200), nullable=False),
        # TASK_STATUS_CODE: pending=1, in_progress=2, done=3, blocked=4, skipped=5.
        sa.Column("status", sa.SmallInteger(), nullable=False),
        # Opaque free text, never SQL-queried — stored compressed (CompressedText → LargeBinary).
        sa.Column("note", sa.LargeBinary(), nullable=False),
        sa.Column("created_at", sa.Integer(), nullable=False),
        sa.Column("updated_at", sa.Integer(), nullable=True),
        sa.CheckConstraint("status IN (1, 2, 3, 4, 5)", name="ck_nova_goal_tasks_status"),
        sa.PrimaryKeyConstraint("workspace_id", "id"),
    )
    op.create_index(
        "ix_nova_goal_tasks_goal",
        "nova_goal_tasks",
        ["workspace_id", "goal_id", "idx", "id"],
        unique=False,
    )

    op.create_table(
        "nova_goal_proposals",
        sa.Column("workspace_id", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("id", Uuid16(), nullable=False),
        # Relates to nova_goals.id; no DB FK (Rule R032).
        sa.Column("goal_id", Uuid16(), nullable=False),
        # Opaque free text, never SQL-queried — stored compressed (CompressedText → LargeBinary).
        sa.Column("reason", sa.LargeBinary(), nullable=False),
        # JSON array of {"title", "keep_task_id"}, stored compressed
        # (CompressedText → LargeBinary).
        sa.Column("tasks", sa.LargeBinary(), nullable=False),
        # PROPOSAL_STATUS_CODE: open=1, accepted=2, dismissed=3, withdrawn=4.
        sa.Column("status", sa.SmallInteger(), nullable=False),
        sa.Column("created_at", sa.Integer(), nullable=False),
        sa.Column("decided_at", sa.Integer(), nullable=True),
        sa.CheckConstraint("status IN (1, 2, 3, 4)", name="ck_nova_goal_proposals_status"),
        sa.PrimaryKeyConstraint("workspace_id", "id"),
    )
    op.create_index(
        "ix_nova_goal_proposals_goal",
        "nova_goal_proposals",
        ["workspace_id", "goal_id", "created_at", "id"],
        unique=False,
    )


def downgrade() -> None:
    """Drop the goals tables."""
    op.drop_index("ix_nova_goal_proposals_goal", table_name="nova_goal_proposals")
    op.drop_table("nova_goal_proposals")
    op.drop_index("ix_nova_goal_tasks_goal", table_name="nova_goal_tasks")
    op.drop_table("nova_goal_tasks")
    op.drop_index("ix_nova_goals_user", table_name="nova_goals")
    op.drop_table("nova_goals")
