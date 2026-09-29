"""Nova's feed primitive: what it tells the person while they're away.

See ``README.md`` for the tables and the full picture. The public surface —
the only names another module may import from this package — is exactly
what is re-exported below.
"""

from __future__ import annotations

from omnigent.nova._shared import lazy_store
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

def create_store(storage_location: str) -> FeedStore:
    """Build the feed store for *storage_location*.

    :param storage_location: The Omnigent operational database's URI.
    :returns: A ready-to-use :class:`FeedStore`.
    """
    return SqlAlchemyFeedStore(storage_location)


# The store used where no NovaDeps is available (this primitive's own
# tools.py). See omnigent.nova._shared.storage.lazy_store. Tests that need
# an isolated store patch this directly, e.g.
# ``monkeypatch.setattr(feed, "_runtime_store", lambda: store)``.
_runtime_store = lazy_store(create_store)
