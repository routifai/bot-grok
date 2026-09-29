"""Nova asks tables.

Owned by omnigent/nova/asks/ (see its README). Creates ``nova_asks``: one row
per Ask ("waiting on you" — an approval, a question, a proposal, a blocked
task, or a skill offer), durable across restarts unlike Omnigent's own
in-process elicitations.

Additive. No foreign-key constraints (schema Rule R032): relationships
(session, goal, task, elicitation) are maintained by the application.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from omnigent.db.db_models import Uuid16

revision: str = "nova04asks"
down_revision: str | None = "nova03goals"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create the ``nova_asks`` table."""
    op.create_table(
        "nova_asks",
        sa.Column("workspace_id", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("id", Uuid16(), nullable=False),
        sa.Column("user_id", sa.String(128), nullable=False),
        sa.Column("session_id", Uuid16(), nullable=True),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("text", sa.String(1000), nullable=False),
        sa.Column("detail", sa.String(4000), nullable=True),
        sa.Column("actions_json", sa.String(2000), nullable=True),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("answer", sa.String(4000), nullable=True),
        # ``elicit_<32 hex>`` (see orchestration.py's token_hex(16) mint) —
        # longer than a bare Uuid16, so a plain bounded string.
        sa.Column("elicitation_id", sa.String(64), nullable=True),
        sa.Column("goal_id", Uuid16(), nullable=True),
        sa.Column("task_id", Uuid16(), nullable=True),
        sa.Column("created_at", sa.Integer(), nullable=False),
        sa.Column("answered_at", sa.Integer(), nullable=True),
        sa.PrimaryKeyConstraint("workspace_id", "id"),
    )
    # "Waiting on you": open asks for a person, newest first. created_at and
    # id trail so the ORDER BY is served by a backward index scan rather than
    # a descending index (Rule: no descending indexes).
    op.create_index(
        "ix_nova_asks_open",
        "nova_asks",
        ["workspace_id", "user_id", "status", "created_at", "id"],
        unique=False,
    )
    # expire_for_session: bulk-close the open asks tied to one session.
    op.create_index(
        "ix_nova_asks_session",
        "nova_asks",
        ["workspace_id", "session_id", "status"],
        unique=False,
    )
    # Elicitation bridge dedup: a republished response.elicitation_request
    # must not mint a second Ask. NULLs (most Asks have no elicitation) are
    # distinct from one another under a unique index on every supported
    # engine, so this never blocks ordinary Asks.
    op.create_index(
        "ix_nova_asks_elicitation",
        "nova_asks",
        ["workspace_id", "elicitation_id"],
        unique=True,
    )


def downgrade() -> None:
    """Drop the ``nova_asks`` table."""
    op.drop_index("ix_nova_asks_elicitation", table_name="nova_asks")
    op.drop_index("ix_nova_asks_session", table_name="nova_asks")
    op.drop_index("ix_nova_asks_open", table_name="nova_asks")
    op.drop_table("nova_asks")
