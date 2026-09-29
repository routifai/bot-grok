"""Nova asks tables.

Owned by omnigent/nova/asks/ (see its README). Placeholder until that primitive
defines its tables; the revision order of the Nova chain is fixed here so the
primitives can be built in parallel.
"""

from __future__ import annotations

from collections.abc import Sequence

revision: str = "nova04asks"
down_revision: str | None = "nova03goals"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create the asks tables."""


def downgrade() -> None:
    """Drop the asks tables."""
