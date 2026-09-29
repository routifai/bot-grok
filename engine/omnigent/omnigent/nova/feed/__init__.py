"""Nova's feed primitive: what it tells the person while they're away.

See ``README.md`` for the tables and the full picture. The public surface —
the only names another module may import from this package — is exactly
what is re-exported below.
"""

from __future__ import annotations

from omnigent.nova.feed.entities import FeedPost, FollowedTopic, Idea, IdeaDraft, PostKind
from omnigent.nova.feed.service import FeedService, digest_schedule
from omnigent.nova.feed.sqlalchemy_store import SqlAlchemyFeedStore
from omnigent.nova.feed.store import FeedStore, PostPage

__all__ = [
    "FeedPost",
    "FeedService",
    "FeedStore",
    "FollowedTopic",
    "Idea",
    "IdeaDraft",
    "PostKind",
    "PostPage",
    "create_store",
    "digest_schedule",
]

# Lazily built, process-wide store used where no ``NovaDeps`` is available
# (this primitive's own ``tools.py``) — mirrors ``omnigent.nova.memory``'s
# ``_runtime_store`` convention.
_store: FeedStore | None = None


def create_store(storage_location: str) -> FeedStore:
    """Build the feed store for *storage_location*.

    :param storage_location: The Omnigent operational database's URI.
    :returns: A ready-to-use :class:`FeedStore`.
    """
    return SqlAlchemyFeedStore(storage_location)


def _runtime_store() -> FeedStore:
    """The store used where no :class:`NovaDeps` is available.

    ``tools.py`` is called from deep inside the runtime, not from a route
    handler, so it has no ``NovaDeps`` to read ``storage_location`` from. It
    goes through Omnigent's already-initialized conversation store instead,
    which lives in the same operational database (see
    ``NovaDeps(storage_location=...)`` in ``server/app.py``) — one
    configuration path, not two. Cached for the process;
    :func:`omnigent.db.utils.get_or_create_engine` already caches the
    underlying engine by URI, so this is a small convenience on top, not the
    only thing keeping repeated calls cheap.

    Tests that need an isolated store patch this function directly (e.g.
    ``monkeypatch.setattr(feed, "_runtime_store", lambda: store)``).
    """
    global _store
    if _store is None:
        from omnigent.runtime import get_conversation_store

        _store = create_store(get_conversation_store().storage_location)
    return _store
