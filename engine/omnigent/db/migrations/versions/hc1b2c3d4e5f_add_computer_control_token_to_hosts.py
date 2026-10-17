"""Add computer control token to hosts.

Revision ID: hc1b2c3d4e5f
Revises: nn1a2b3c4d5e
Create Date: 2026-10-03 00:00:00.000000

A person taking over a managed host's computer screen holds a control token.
Persisting it on the host row lets the take-over survive a server restart and
be seen by every replica.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "hc1b2c3d4e5f"
down_revision: str | None = "nn1a2b3c4d5e"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Add the nullable control-token column."""
    with op.batch_alter_table("hosts") as batch_op:
        batch_op.add_column(sa.Column("computer_control_token", sa.String(64), nullable=True))


def downgrade() -> None:
    """Remove the control-token column."""
    with op.batch_alter_table("hosts") as batch_op:
        batch_op.drop_column("computer_control_token")
