"""Nova Asks: what's waiting on the person, durably.

See ``README.md`` for the tables and the full picture. The public surface —
the only names another module may import from this package — is exactly
what is re-exported below.
"""

from __future__ import annotations

from omnigent.nova.asks.entities import Ask, AskAction, AskKind, AskStatus
from omnigent.nova.asks.service import AskService
from omnigent.nova.asks.sqlalchemy_store import SqlAlchemyAskStore
from omnigent.nova.asks.store import AskStore

__all__ = [
    "Ask",
    "AskAction",
    "AskKind",
    "AskService",
    "AskStatus",
    "AskStore",
    "create_store",
]

# Lazily built, process-wide store used by tools.py, context.py and
# bridge.py — the places with no NovaDeps to thread a storage_location
# through. routes.py has deps and calls create_store directly instead.
_store: AskStore | None = None


def create_store(storage_location: str) -> AskStore:
    """Build the Ask store for *storage_location*.

    :param storage_location: The Omnigent operational database's URI.
    :returns: A ready-to-use :class:`AskStore`.
    """
    return SqlAlchemyAskStore(storage_location)


def _runtime_store() -> AskStore:
    """The store used where no :class:`~omnigent.nova._shared.NovaDeps` is available.

    ``tools.py`` (``nova_ask_user``), ``context.py`` and ``bridge.py`` are
    called from deep inside the runtime — a tool invocation or the SSE
    publish chokepoint — not from a route handler, so none of them has a
    ``NovaDeps`` to read ``storage_location`` from. All three go through
    Omnigent's already-initialized conversation store instead, which lives
    in the same operational database (see ``NovaDeps(storage_location=...)``
    in ``server/app.py``) — one configuration path, not two. Cached for the
    process; :func:`omnigent.db.utils.get_or_create_engine` already caches
    the underlying engine by URI, so this is a small convenience on top, not
    the only thing keeping repeated calls cheap.

    Tests that need an isolated store patch this function directly (e.g.
    ``monkeypatch.setattr(asks, "_runtime_store", lambda: store)``).
    """
    global _store
    if _store is None:
        from omnigent.runtime import get_conversation_store

        _store = create_store(get_conversation_store().storage_location)
    return _store


def _runtime_service() -> AskService:
    """The :class:`AskService` used where no ``NovaDeps`` is available.

    See :func:`_runtime_store`.
    """
    return AskService(_runtime_store())
