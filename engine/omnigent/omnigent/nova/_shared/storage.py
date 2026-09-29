"""The operational database when no :class:`~omnigent.nova._shared.deps.NovaDeps`
is in hand.

A route handler always has ``NovaDeps.storage_location``. A tool factory, a
context section and a turn-completion observer run deep inside the runtime
instead and have no such thing — they resolve the same database through
Omnigent's already-initialized conversation store, which lives in it too
(see ``NovaDeps(storage_location=...)`` in ``server/app.py``): one
configuration path, not two.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Generic, TypeVar

_StoreT = TypeVar("_StoreT")


def storage_location() -> str:
    """The Omnigent operational database's URI, read from the conversation store.

    :returns: The database URI.
    :raises RuntimeError: If ``omnigent.runtime`` has not been initialized.
    """
    from omnigent.runtime import get_conversation_store

    return get_conversation_store().storage_location


class LazyStore(Generic[_StoreT]):
    """A process-wide store, built once from :func:`storage_location`.

    :func:`omnigent.db.utils.get_or_create_engine` already caches the
    underlying engine by URI, so caching here is a small convenience on top
    — one store instance per process, not the only thing keeping repeated
    calls cheap.
    """

    def __init__(self, factory: Callable[[str], _StoreT]) -> None:
        """
        :param factory: Builds the store from the operational database URI,
            e.g. a primitive's own ``create_store``.
        """
        self._factory = factory
        self._store: _StoreT | None = None

    def __call__(self) -> _StoreT:
        """The cached store, building it on first use."""
        if self._store is None:
            self._store = self._factory(storage_location())
        return self._store

    def reset(self) -> None:
        """Drop the cached store so the next call rebuilds it.

        Tests use this so one test's store (its own ``db_uri``) never leaks
        into the next; module-level state otherwise persists for the whole
        test process.
        """
        self._store = None


def lazy_store(factory: Callable[[str], _StoreT]) -> LazyStore[_StoreT]:
    """One-line, per-primitive accessor for the store used where no
    ``NovaDeps`` is in hand.

    :param factory: Builds the store from the operational database URI, e.g.
        a primitive's own ``create_store``.
    :returns: A zero-argument, cached accessor: call it to get the store.
    """
    return LazyStore(factory)
