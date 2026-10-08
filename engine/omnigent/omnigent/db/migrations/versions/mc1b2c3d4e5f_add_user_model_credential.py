"""Add ``user_model_credential``: one sealed provider API key per user.

Revision ID: mc1b2c3d4e5f
Revises: ml1b2c3d4e5f
Create Date: 2026-10-08 00:00:00.000000

The key is stored only as AES-GCM ciphertext; ``hint`` is its last 4 characters. The primary key
``(workspace_id, user_id)`` allows exactly one active key per user.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "mc1b2c3d4e5f"
down_revision: str | None = "ml1b2c3d4e5f"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create the table."""
    op.create_table(
        "user_model_credential",
        sa.Column("workspace_id", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("user_id", sa.String(128), nullable=False),
        sa.Column("provider", sa.String(16), nullable=False),
        sa.Column("ciphertext", sa.Text(), nullable=False),
        sa.Column("hint", sa.String(8), nullable=False),
        sa.Column("validated_at", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(8), nullable=False, server_default="valid"),
        sa.Column("created_at", sa.Integer(), nullable=False),
        sa.Column("updated_at", sa.Integer(), nullable=False),
        sa.PrimaryKeyConstraint("workspace_id", "user_id"),
        sa.CheckConstraint(
            "provider IN ('anthropic', 'openrouter')", name="ck_user_model_credential_provider"
        ),
        sa.CheckConstraint(
            "status IN ('valid', 'invalid')", name="ck_user_model_credential_status"
        ),
    )


def downgrade() -> None:
    """Drop the table."""
    op.drop_table("user_model_credential")
