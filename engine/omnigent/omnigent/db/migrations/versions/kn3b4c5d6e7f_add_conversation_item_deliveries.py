"""Add conversation_item_deliveries: how each message sent to a session was taken.

Revision ID: kn3b4c5d6e7f
Revises: sa1b2c3d4e5f
Create Date: 2026-10-09 22:00:00.000000

A message sent while a turn runs is steered into it or queued behind it, then runs as a turn
or is cancelled by a stop. The runner reports each step; the server keeps the latest per
message here so every replica and a reloaded client see the same state. Additive; no
backfill (older messages simply have no row).
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from omnigent.db.db_models import Uuid16

revision: str = "kn3b4c5d6e7f"
down_revision: str | None = "sa1b2c3d4e5f"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create ``conversation_item_deliveries`` (skipped when it already exists)."""
    if sa.inspect(op.get_bind()).has_table("conversation_item_deliveries"):
        return
    op.create_table(
        "conversation_item_deliveries",
        sa.Column("workspace_id", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("conversation_id", Uuid16(), nullable=False),
        sa.Column("item_id", Uuid16(), nullable=False),
        sa.Column("delivered", sa.String(16), nullable=False),
        sa.Column("updated_at", sa.Integer(), nullable=False),
        sa.PrimaryKeyConstraint("workspace_id", "conversation_id", "item_id"),
    )


def downgrade() -> None:
    """Drop ``conversation_item_deliveries``."""
    op.drop_table("conversation_item_deliveries")
