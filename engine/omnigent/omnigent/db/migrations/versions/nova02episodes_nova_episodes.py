"""Nova episodes tables.

Owned by omnigent/nova/episodes/ (see its README). Creates ``nova_episodes``:
one dated row per finished task Nova did for a person, keyed by the person
(``user_id``), not a session. Additive, no foreign keys (schema Rule R032):
the ``session_id`` relationship to ``conversations`` is enforced by the
application, not the database.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from omnigent.db.db_models import Uuid16

revision: str = "nova02episodes"
down_revision: str | None = "nova01memory"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create the ``nova_episodes`` table."""
    op.create_table(
        "nova_episodes",
        sa.Column("workspace_id", sa.BigInteger(), nullable=False, server_default="0"),
        # UUID PK stored as 16 raw bytes (Uuid16), read back as bare hex.
        sa.Column("id", Uuid16(), nullable=False),
        # Owning person; episodes are private and keyed by person, never a bot.
        sa.Column("user_id", sa.String(128), nullable=False),
        sa.Column("session_id", sa.String(64), nullable=False),
        # The turn's response id: ties one finished turn to at most one
        # episode row so a relay reconnect replaying a turn cannot duplicate
        # it (see ix_nova_episodes_turn below).
        sa.Column("turn_id", sa.String(64), nullable=False),
        # Bounded per DATABASE_BEST_PRACTICES.md: capped in
        # omnigent.nova.episodes.service.build_episode before every write
        # (200 chars / 1200 chars, well under the 16 KiB column limit at
        # 4 bytes/char worst case).
        sa.Column("title", sa.String(256), nullable=False),
        sa.Column("summary", sa.String(1536), nullable=False),
        # Compact JSON arrays (deduped tool names; extracted http(s) links),
        # each capped in service.py to a small fixed item count and per-item
        # length so the encoded column value always stays far under 16 KiB.
        sa.Column("tools", sa.String(1536), nullable=False),
        sa.Column("links", sa.String(2560), nullable=False),
        sa.Column("created_at", sa.Integer(), nullable=False),
        sa.Column("updated_at", sa.Integer(), nullable=True),
        sa.PrimaryKeyConstraint("workspace_id", "id"),
    )
    # Idempotent-recording key: at most one episode per turn. Also the
    # natural lookup for "does this turn already have an episode".
    op.create_index(
        "ix_nova_episodes_turn",
        "nova_episodes",
        ["workspace_id", "session_id", "turn_id"],
        unique=True,
    )
    # Recall/list order: "this person's most recent episodes". Ascending
    # index, traversed backward (created_at DESC, id DESC) per the no
    # descending-index rule.
    op.create_index(
        "ix_nova_episodes_user",
        "nova_episodes",
        ["workspace_id", "user_id", "created_at", "id"],
        unique=False,
    )


def downgrade() -> None:
    """Drop the ``nova_episodes`` table."""
    op.drop_index("ix_nova_episodes_user", table_name="nova_episodes")
    op.drop_index("ix_nova_episodes_turn", table_name="nova_episodes")
    op.drop_table("nova_episodes")
