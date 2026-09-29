"""Nova memory tables.

Owned by omnigent/nova/memory/ (see its README). Placeholder until that primitive
defines its tables; the revision order of the Nova chain is fixed here so the
primitives can be built in parallel.
"""

from __future__ import annotations

from collections.abc import Sequence

revision: str = "nova01memory"
down_revision: str | None = "ll1a2b3c4d5e"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create the memory tables."""


def downgrade() -> None:
    """Drop the memory tables."""
