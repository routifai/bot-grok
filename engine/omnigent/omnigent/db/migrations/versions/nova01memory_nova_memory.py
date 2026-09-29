"""Nova memory tables.

Owned by omnigent/nova/memory/ (see its README and tables.py). Creates the
three tables backing Nova's memory primitive:

- ``nova_memory_notes`` — one row per person per ``(kind, path)``, holding
  current content and a revision counter.
- ``nova_memory_revisions`` — append-only history of a note's content.
- ``nova_memory_profiles`` — a person's timezone and display name.

All brand-new, so every table carries ``workspace_id`` leading its primary
key, and none carries a database foreign key (Rule R032 — the ``note_id``
relationship between the notes and revisions tables is enforced in
``SqlAlchemyMemoryStore``, not the database).
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from omnigent.db.db_models import Uuid16

revision: str = "nova01memory"
down_revision: str | None = "ll1a2b3c4d5e"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create the memory tables."""
    op.create_table(
        "nova_memory_notes",
        sa.Column("workspace_id", sa.BigInteger(), nullable=False, server_default="0"),
        # UUID PK stored as 16 raw bytes (Uuid16 → BINARY(16) on MySQL, BLOB/BYTEA
        # elsewhere).
        sa.Column("id", Uuid16(), nullable=False),
        sa.Column("user_id", sa.String(128), nullable=False),
        # Stable int code (see tables.py NOTE_KIND_CODE): 1=nova, 2=about_you.
        sa.Column("kind", sa.SmallInteger(), nullable=False),
        sa.Column("path", sa.String(1024), nullable=False),
        # Opaque markdown, never SQL-filtered — stored compressed
        # (CompressedText → LargeBinary at the ORM layer).
        sa.Column("content", sa.LargeBinary(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.Integer(), nullable=False),
        sa.Column("updated_at", sa.Integer(), nullable=False),
        sa.CheckConstraint("kind IN (1, 2)", name="ck_nova_memory_notes_kind"),
        # The natural key a note is looked up and upserted by; also the sole
        # uniqueness guard for "one note per (person, kind, path)" — matches
        # tables.py's SqlMemoryNote.__table_args__ UniqueConstraint of the same
        # name. Declared inline (not via a later create_unique_constraint):
        # SQLite cannot ALTER a table to add a constraint after the fact.
        sa.UniqueConstraint(
            "workspace_id", "user_id", "kind", "path", name="uq_nova_memory_notes_identity"
        ),
        sa.PrimaryKeyConstraint("workspace_id", "id"),
    )
    # "This person's notes, newest first" as a pure index scan; id breaks ties.
    op.create_index(
        "ix_nova_memory_notes_listing",
        "nova_memory_notes",
        ["workspace_id", "user_id", "updated_at", "id"],
        unique=False,
    )

    op.create_table(
        "nova_memory_revisions",
        sa.Column("workspace_id", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("note_id", Uuid16(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        # Opaque markdown snapshot, stored compressed (CompressedText).
        sa.Column("content", sa.LargeBinary(), nullable=False),
        sa.Column("created_at", sa.Integer(), nullable=False),
        sa.PrimaryKeyConstraint("workspace_id", "note_id", "revision"),
    )

    op.create_table(
        "nova_memory_profiles",
        sa.Column("workspace_id", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("user_id", sa.String(128), nullable=False),
        sa.Column("timezone", sa.String(64), nullable=False),
        sa.Column("display_name", sa.String(256), nullable=True),
        sa.Column("created_at", sa.Integer(), nullable=False),
        sa.Column("updated_at", sa.Integer(), nullable=False),
        sa.PrimaryKeyConstraint("workspace_id", "user_id"),
    )


def downgrade() -> None:
    """Drop the memory tables."""
    op.drop_table("nova_memory_profiles")
    op.drop_table("nova_memory_revisions")
    op.drop_index("ix_nova_memory_notes_listing", table_name="nova_memory_notes")
    op.drop_table("nova_memory_notes")
