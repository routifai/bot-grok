"""Nova's skills primitive: repeatable work Nova learns to do again.

See ``README.md`` for the tables and the full picture. The public surface —
the only names another module may import from this package — is exactly
what is re-exported below.
"""

from __future__ import annotations

from omnigent.nova._shared import NovaActor
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

# Lazily built, process-wide store/service used by tools.py and context.py —
# the places with no NovaDeps to thread a storage_location through. routes.py
# has deps and calls create_store directly instead.
_store: SkillStore | None = None


def create_store(storage_location: str) -> SkillStore:
    """Build the skills store for *storage_location*.

    :param storage_location: The Omnigent operational database's URI.
    :returns: A ready-to-use :class:`SkillStore`.
    """
    return SqlAlchemySkillStore(storage_location)


def _runtime_store() -> SkillStore:
    """The store used where no :class:`NovaDeps` is available.

    Mirrors ``omnigent.nova.memory``'s ``_runtime_store()``: ``tools.py`` and
    ``context.py`` are called from deep inside the runtime, not from a route
    handler, so neither has a ``NovaDeps`` to read ``storage_location`` from.
    Both go through Omnigent's already-initialized conversation store
    instead, which lives in the same operational database. Cached for the
    process.

    Tests that need an isolated store patch this function directly (e.g.
    ``monkeypatch.setattr(skills, "_runtime_store", lambda: store)``).
    """
    global _store
    if _store is None:
        from omnigent.runtime import get_conversation_store

        _store = create_store(get_conversation_store().storage_location)
    return _store


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
