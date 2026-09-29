"""Nova skills tables.

Owned by omnigent/nova/skills/ (see its README): ``nova_skills`` (saved
skills) and ``nova_skill_offers`` (pending Save / Not now offers). Matches
``omnigent/nova/skills/tables.py`` exactly — see that module's docstrings for
why each column is shaped the way it is (bounds, no DB foreign keys,
``workspace_id``-leading primary keys).
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from omnigent.db.db_models import Uuid16

revision: str = "nova06skills"
down_revision: str | None = "nova05feed"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create the skills tables."""
    op.create_table(
        "nova_skills",
        sa.Column("workspace_id", sa.BigInteger(), nullable=False, server_default="0"),
        # UUID PK stored as 16 raw bytes (Uuid16 → BINARY(16) on MySQL, BLOB/BYTEA
        # elsewhere).
        sa.Column("id", Uuid16(), nullable=False),
        sa.Column("user_id", sa.String(128), nullable=False),
        sa.Column("name", sa.String(80), nullable=False),
        sa.Column("description", sa.String(2000), nullable=False),
        # Opaque SKILL.md text, never SQL-filtered — stored compressed
        # (CompressedText → LargeBinary at the ORM layer).
        sa.Column("content", sa.LargeBinary(), nullable=False),
        sa.Column("created_at", sa.Integer(), nullable=False),
        sa.Column("updated_at", sa.Integer(), nullable=False),
        # The natural key a skill is looked up, listed and deleted by; also the
        # sole uniqueness guard. Declared inline (not via a later
        # create_unique_constraint): SQLite cannot ALTER a table to add a
        # constraint after the fact.
        sa.UniqueConstraint("workspace_id", "user_id", "name", name="uq_nova_skills_identity"),
        sa.PrimaryKeyConstraint("workspace_id", "id"),
    )

    op.create_table(
        "nova_skill_offers",
        sa.Column("workspace_id", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("id", Uuid16(), nullable=False),
        sa.Column("user_id", sa.String(128), nullable=False),
        sa.Column("name", sa.String(80), nullable=False),
        sa.Column("description", sa.String(2000), nullable=False),
        sa.Column("content", sa.LargeBinary(), nullable=False),
        # 1=open, 2=saved, 3=dismissed (omnigent/nova/skills/tables.py OFFER_STATUS_CODE).
        sa.Column("status", sa.SmallInteger(), nullable=False),
        sa.Column("created_at", sa.Integer(), nullable=False),
        sa.Column("decided_at", sa.Integer(), nullable=True),
        # 1=new, 2=update (omnigent/nova/skills/tables.py OFFER_KIND_CODE): whether
        # accepting the offer creates a skill or replaces an existing one's body.
        sa.Column("offer_kind", sa.SmallInteger(), nullable=False, server_default="1"),
        sa.Column("target_skill", sa.String(80), nullable=True),
        sa.CheckConstraint("status IN (1, 2, 3)", name="ck_nova_skill_offers_status"),
        sa.CheckConstraint("offer_kind IN (1, 2)", name="ck_nova_skill_offers_kind"),
        sa.PrimaryKeyConstraint("workspace_id", "id"),
    )
    op.create_index(
        "ix_nova_skill_offers_open",
        "nova_skill_offers",
        ["workspace_id", "user_id", "status", "created_at", "id"],
        unique=False,
    )
    op.create_index(
        "ix_nova_skill_offers_name",
        "nova_skill_offers",
        ["workspace_id", "user_id", "name", "status"],
        unique=False,
    )


def downgrade() -> None:
    """Drop the skills tables."""
    op.drop_index("ix_nova_skill_offers_name", table_name="nova_skill_offers")
    op.drop_index("ix_nova_skill_offers_open", table_name="nova_skill_offers")
    op.drop_table("nova_skill_offers")
    op.drop_table("nova_skills")
