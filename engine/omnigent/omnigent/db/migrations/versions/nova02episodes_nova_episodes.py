"""Nova episodes tables.

Owned by omnigent/nova/episodes/ (see its README). Placeholder until that primitive
defines its tables; the revision order of the Nova chain is fixed here so the
primitives can be built in parallel.
"""

from __future__ import annotations

from collections.abc import Sequence

revision: str = "nova02episodes"
down_revision: str | None = "nova01memory"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create the episodes tables."""


def downgrade() -> None:
    """Drop the episodes tables."""
