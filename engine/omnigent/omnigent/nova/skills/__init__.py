"""Nova's skills primitive: repeatable work Nova learns to do again.

See ``README.md`` for the tables and the full picture. The public surface —
the only names another module may import from this package — is exactly
what is re-exported below.
"""

from __future__ import annotations

from omnigent.nova._shared import NovaActor, lazy_store
from omnigent.nova.skills.entities import OfferStatus, Skill, SkillOffer
from omnigent.nova.skills.service import (
    CONTENT_MAX_CHARS,
    DESCRIPTION_MAX_CHARS,
    NAME_MAX_CHARS,
    SkillService,
    build_skill_md,
    parse_skill_md,
)
from omnigent.nova.skills.sqlalchemy_store import SqlAlchemySkillStore
from omnigent.nova.skills.store import SkillStore

__all__ = [
    "CONTENT_MAX_CHARS",
    "DESCRIPTION_MAX_CHARS",
    "NAME_MAX_CHARS",
    "OfferStatus",
    "Skill",
    "SkillOffer",
    "SkillService",
    "SkillStore",
    "build_skill_md",
    "create_store",
    "open_offers",
    "parse_skill_md",
]

def create_store(storage_location: str) -> SkillStore:
    """Build the skills store for *storage_location*.

    :param storage_location: The Omnigent operational database's URI.
    :returns: A ready-to-use :class:`SkillStore`.
    """
    return SqlAlchemySkillStore(storage_location)


# The store used where no NovaDeps is available: tools.py and context.py.
# See omnigent.nova._shared.storage.lazy_store. Tests that need an isolated
# store patch this directly, e.g.
# ``monkeypatch.setattr(skills, "_runtime_store", lambda: store)``.
_runtime_store = lazy_store(create_store)


def _runtime_service() -> SkillService:
    """The :class:`SkillService` used where no ``NovaDeps`` is available.

    See :func:`_runtime_store`.
    """
    return SkillService(_runtime_store())


def open_offers(actor: NovaActor) -> list[SkillOffer]:
    """The person's open skill offers, newest first.

    Public so ``asks/`` can list skill offers alongside its own Asks without
    reaching into this primitive's internals (``nova/README.md`` rule 1).

    :param actor: Whose offers to list.
    :returns: The person's open offers.
    """
    return _runtime_service().open_offers(actor)
