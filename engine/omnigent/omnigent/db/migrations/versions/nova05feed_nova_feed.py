"""Nova feed tables.

Owned by omnigent/nova/feed/ (see its README): ``nova_feed_posts``,
``nova_feed_topics``, ``nova_feed_ideas``. Matches
``omnigent/nova/feed/tables.py`` exactly — see that module's docstrings for
why each column is shaped the way it is (bounds, no DB foreign keys,
``workspace_id``-leading primary keys).
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from omnigent.db.db_models import Uuid16

revision: str = "nova05feed"
down_revision: str | None = "nova04asks"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create the feed tables."""
    op.create_table(
        "nova_feed_posts",
        sa.Column("workspace_id", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("id", Uuid16(), nullable=False),
        sa.Column("user_id", sa.String(128), nullable=True),
        # 1=goal_report, 2=topic (omnigent/nova/feed/tables.py POST_KIND_CODES).
        sa.Column("kind", sa.Integer(), nullable=False),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("body", sa.String(2000), nullable=False),
        sa.Column("goal_id", Uuid16(), nullable=True),
        sa.Column("source_url", sa.String(2048), nullable=True),
        sa.Column("created_at", sa.Integer(), nullable=False),
        sa.CheckConstraint("kind IN (1, 2)", name="ck_nova_feed_posts_kind"),
        sa.PrimaryKeyConstraint("workspace_id", "id"),
    )
    op.create_index(
        "ix_nova_feed_posts_user_id",
        "nova_feed_posts",
        ["workspace_id", "user_id", "created_at", "id"],
        unique=False,
    )

    op.create_table(
        "nova_feed_topics",
        sa.Column("workspace_id", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("id", Uuid16(), nullable=False),
        sa.Column("user_id", sa.String(128), nullable=True),
        sa.Column("topic", sa.String(200), nullable=False),
        sa.Column("created_at", sa.Integer(), nullable=False),
        sa.PrimaryKeyConstraint("workspace_id", "id"),
    )
    op.create_index(
        "ix_nova_feed_topics_user_id",
        "nova_feed_topics",
        ["workspace_id", "user_id", "created_at", "id"],
        unique=False,
    )

    op.create_table(
        "nova_feed_ideas",
        sa.Column("workspace_id", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("id", Uuid16(), nullable=False),
        sa.Column("user_id", sa.String(128), nullable=True),
        sa.Column("text", sa.String(160), nullable=False),
        sa.Column("area", sa.String(24), nullable=False),
        sa.Column("detail", sa.String(320), nullable=True),
        sa.Column("illustration", sa.String(64), nullable=True),
        sa.Column("created_at", sa.Integer(), nullable=False),
        sa.PrimaryKeyConstraint("workspace_id", "id"),
    )
    op.create_index(
        "ix_nova_feed_ideas_user_id",
        "nova_feed_ideas",
        ["workspace_id", "user_id", "created_at", "id"],
        unique=False,
    )


def downgrade() -> None:
    """Drop the feed tables."""
    op.drop_index("ix_nova_feed_ideas_user_id", table_name="nova_feed_ideas")
    op.drop_table("nova_feed_ideas")
    op.drop_index("ix_nova_feed_topics_user_id", table_name="nova_feed_topics")
    op.drop_table("nova_feed_topics")
    op.drop_index("ix_nova_feed_posts_user_id", table_name="nova_feed_posts")
    op.drop_table("nova_feed_posts")
