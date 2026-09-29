"""Nova Asks: what's waiting on the person, durably.

See ``README.md`` for the tables and the full picture. The public surface —
the only names another module may import from this package — is exactly
what is re-exported below.
"""

from __future__ import annotations

from omnigent.nova._shared import lazy_store
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

def create_store(storage_location: str) -> AskStore:
    """Build the Ask store for *storage_location*.

    :param storage_location: The Omnigent operational database's URI.
    :returns: A ready-to-use :class:`AskStore`.
    """
    return SqlAlchemyAskStore(storage_location)


# The store used where no NovaDeps is available: tools.py (nova_ask_user),
# context.py and bridge.py. See omnigent.nova._shared.storage.lazy_store.
# Tests that need an isolated store patch this directly, e.g.
# ``monkeypatch.setattr(asks, "_runtime_store", lambda: store)``.
_runtime_store = lazy_store(create_store)


def _runtime_service() -> AskService:
    """The :class:`AskService` used where no ``NovaDeps`` is available.

    See :func:`_runtime_store`.
    """
    return AskService(_runtime_store())
