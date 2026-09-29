"""The store this primitive's route, tool and observer all share.

``routes.create_router`` is the only entry point the server hands a
:class:`~omnigent.nova._shared.NovaDeps` (see ``omnigent/nova/_registry.py``);
``tools.py``'s factory and ``observer.py``'s turn-completion hook are called
without one. Both read the store configured here instead of building their
own, so there is exactly one store per process.
"""

from __future__ import annotations

from omnigent.nova.episodes.sqlalchemy_store import SqlAlchemyEpisodeStore
from omnigent.nova.episodes.store import EpisodeStore

_store: EpisodeStore | None = None


def configure(storage_location: str) -> None:
    """Build and cache the store every other module in this primitive reads.

    Safe to call more than once (e.g. router re-creation in tests); the last
    call wins.

    :param storage_location: Database URI for the Omnigent operational tables.
    """
    global _store
    _store = SqlAlchemyEpisodeStore(storage_location)


def store() -> EpisodeStore | None:
    """The configured store, or ``None`` before ``configure`` has run."""
    return _store
