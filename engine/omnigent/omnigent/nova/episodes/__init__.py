"""Episodes: a dated record of each finished task, and recall of past ones.

See ``README.md`` for what this primitive owns. Other code imports only what
is re-exported here — never ``omnigent.nova.episodes.<internal module>``
directly (Nova rule #1).
"""

from omnigent.nova._shared import lazy_store
from omnigent.nova.episodes.entities import Episode
from omnigent.nova.episodes.service import (
    NO_RESPONSE,
    WORK_TOOLS,
    BuiltEpisode,
    build_episode,
    rank_episodes,
    record_turn,
    render_episodes,
)
from omnigent.nova.episodes.sqlalchemy_store import SqlAlchemyEpisodeStore
from omnigent.nova.episodes.store import EpisodeStore

__all__ = [
    "NO_RESPONSE",
    "WORK_TOOLS",
    "BuiltEpisode",
    "Episode",
    "EpisodeStore",
    "build_episode",
    "create_store",
    "rank_episodes",
    "record_turn",
    "render_episodes",
    "runtime_store",
]


def create_store(storage_location: str) -> EpisodeStore:
    """Build the episode store for *storage_location*.

    :param storage_location: The Omnigent operational database's URI.
    :returns: A ready-to-use :class:`EpisodeStore`.
    """
    return SqlAlchemyEpisodeStore(storage_location)


# The store used where no NovaDeps is available: tools.py
# (nova_recall_episodes), context.py and observer.py. See
# omnigent.nova._shared.storage.lazy_store. Tests that need an isolated
# store patch this directly, e.g.
# ``monkeypatch.setattr(episodes, "_runtime_store", lambda: store)``.
_runtime_store = lazy_store(create_store)


def runtime_store() -> EpisodeStore:
    """The process-wide episode store used where no ``NovaDeps`` is available.

    Public so another primitive can read episodes without reaching into
    ``_runtime_store`` (nova/README.md rule 1) — used by
    ``skills.gate.has_reuse_evidence`` to check whether a person has done
    similar work before.

    :returns: The shared :class:`EpisodeStore`.
    """
    return _runtime_store()
