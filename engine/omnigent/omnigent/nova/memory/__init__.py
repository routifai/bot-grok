"""Nova's memory primitive: notes Nova keeps about the person and for itself.

See ``README.md`` for the tables and the full picture. The public surface —
the only names another module may import from this package — is exactly
what is re-exported below.
"""

from __future__ import annotations

from omnigent.nova._shared import NovaActor
from omnigent.nova.memory.entities import MemoryNote, MemoryRevision, NoteKind, Profile
from omnigent.nova.memory.service import DEFAULT_PATH, remember, render_memory
from omnigent.nova.memory.sqlalchemy_store import SqlAlchemyMemoryStore
from omnigent.nova.memory.store import MemoryStore

__all__ = [
    "DEFAULT_PATH",
    "MemoryNote",
    "MemoryRevision",
    "MemoryStore",
    "NoteKind",
    "Profile",
    "create_store",
    "get_profile",
    "remember",
    "render_memory",
    "set_timezone",
]

# Lazily built, process-wide store used by get_profile/set_timezone (and, via
# the package attribute below, by tools.py and context.py) — the places with
# no NovaDeps to thread a storage_location through. routes.py has deps and
# calls create_store directly instead.
_store: MemoryStore | None = None


def create_store(storage_location: str) -> MemoryStore:
    """Build the memory store for *storage_location*.

    :param storage_location: The Omnigent operational database's URI.
    :returns: A ready-to-use :class:`MemoryStore`.
    """
    return SqlAlchemyMemoryStore(storage_location)


def _runtime_store() -> MemoryStore:
    """The store used where no :class:`NovaDeps` is available.

    ``context/provider.py`` (resolving a person's timezone) and this
    primitive's own ``tools.py`` (``nova_remember``) are called from deep
    inside the runtime, not from a route handler, so neither has a
    ``NovaDeps`` to read ``storage_location`` from. Both go through Omnigent's
    already-initialized conversation store instead, which lives in the same
    operational database (see ``NovaDeps(storage_location=...)`` in
    ``server/app.py``) — one configuration path, not two. Cached for the
    process; :func:`omnigent.db.utils.get_or_create_engine` already caches
    the underlying engine by URI, so this is a small convenience on top, not
    the only thing keeping repeated calls cheap.

    Tests that need an isolated store patch this function directly (e.g.
    ``monkeypatch.setattr(memory, "_runtime_store", lambda: store)``).
    """
    global _store
    if _store is None:
        from omnigent.runtime import get_conversation_store

        _store = create_store(get_conversation_store().storage_location)
    return _store


def get_profile(actor: NovaActor) -> Profile:
    """The person's Nova profile (timezone, display name).

    :param actor: Whose profile to read.
    :returns: The stored profile, or a default (``timezone="UTC"``) view if
        they have never set one.
    """
    return _runtime_store().get_profile(actor)


def set_timezone(actor: NovaActor, timezone: str) -> Profile:
    """Set the person's IANA timezone.

    :param actor: Whose profile to update.
    :param timezone: An IANA timezone name, e.g. ``"America/Toronto"``.
    :returns: The updated profile.
    :raises OmnigentError: ``INVALID_INPUT`` if *timezone* is not a valid
        IANA zone.
    """
    return _runtime_store().set_timezone(actor, timezone)
