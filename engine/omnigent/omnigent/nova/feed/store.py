"""The feed store interface.

Every method is scoped by ``user_id``: the feed is owner-private, mirroring
``ProjectStore`` (``omnigent/stores/project_store/__init__.py``). Workspace is
an ambient DB partition the implementation reads via ``current_workspace_id``,
not a parameter here — same split as ``ProjectStore`` / :class:`Project`.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass

from omnigent.nova.feed.entities import FeedPost, FollowedTopic, Idea, IdeaDraft, PostKind

# `list_posts` page size (mirrors the TypeScript prototype's POST_PAGE_SIZE).
POST_PAGE_SIZE = 30


@dataclass(frozen=True)
class PostPage:
    """One page of `list_posts`.

    :param posts: This page's posts, newest first.
    :param next_cursor: Opaque cursor for the next page, or ``None`` when this
        was the last page.
    """

    posts: list[FeedPost]
    next_cursor: str | None


class FeedStore(ABC):
    """Abstract base for feed persistence: posts, followed topics, and ideas."""

    def __init__(self, storage_location: str) -> None:
        """
        :param storage_location: Backend-specific storage URI, e.g.
            ``"sqlite:///chat.db"`` for SQLAlchemy.
        """
        self.storage_location = storage_location

    # ── posts ────────────────────────────────────────────────────────────

    @abstractmethod
    def create_post(
        self,
        post_id: str,
        *,
        user_id: str | None,
        kind: PostKind,
        title: str,
        body: str,
        goal_id: str | None = None,
        source_url: str | None = None,
    ) -> FeedPost:
        """Create one post (a Goal report or a Followed-topic finding).

        :param post_id: Pre-generated unique post id.
        :param user_id: Owning person, or ``None`` in single-user mode.
        :param kind: ``"goal_report"`` or ``"topic"``.
        :param title: Short headline.
        :param body: One-to-a-few-sentence body.
        :param goal_id: The Goal this reports on, for ``kind="goal_report"``.
        :param source_url: The http(s) source a topic finding cites.
        :returns: The created :class:`FeedPost`.
        """

    @abstractmethod
    def list_posts(
        self,
        *,
        user_id: str | None,
        cursor: str | None = None,
        limit: int = POST_PAGE_SIZE,
    ) -> PostPage:
        """List an owner's posts, newest first.

        :param user_id: Owning person, or ``None`` in single-user mode.
        :param cursor: An opaque cursor from a previous page, or ``None`` for
            the first page.
        :param limit: Max posts to return.
        :returns: The requested page.
        :raises OmnigentError: ``INVALID_INPUT`` if ``cursor`` is malformed.
        """

    # ── followed topics ─────────────────────────────────────────────────

    @abstractmethod
    def list_topics(self, *, user_id: str | None) -> list[FollowedTopic]:
        """List an owner's followed topics, oldest-followed first.

        :param user_id: Owning person, or ``None`` in single-user mode.
        :returns: The owner's followed topics.
        """

    @abstractmethod
    def count_topics(self, *, user_id: str | None) -> int:
        """Count an owner's followed topics (for the 20-topic cap).

        :param user_id: Owning person, or ``None`` in single-user mode.
        :returns: The number of topics currently followed.
        """

    @abstractmethod
    def get_topic_by_name(self, *, user_id: str | None, topic: str) -> FollowedTopic | None:
        """Find an owner's existing topic by exact text (for dedupe).

        :param user_id: Owning person, or ``None`` in single-user mode.
        :param topic: The exact topic text to look up.
        :returns: The matching :class:`FollowedTopic`, or ``None``.
        """

    @abstractmethod
    def create_topic(self, topic_id: str, *, user_id: str | None, topic: str) -> FollowedTopic:
        """Insert a new followed topic. Callers dedupe via ``get_topic_by_name`` first.

        :param topic_id: Pre-generated unique topic id.
        :param user_id: Owning person, or ``None`` in single-user mode.
        :param topic: The topic text.
        :returns: The created :class:`FollowedTopic`.
        """

    @abstractmethod
    def get_topic(self, topic_id: str) -> FollowedTopic | None:
        """Return a topic by id regardless of owner, for delete-time ownership checks.

        :param topic_id: The topic to fetch.
        :returns: The :class:`FollowedTopic` if found, else ``None``.
        """

    @abstractmethod
    def delete_topic(self, topic_id: str, *, user_id: str | None) -> bool:
        """Unfollow a topic by id. Idempotent.

        :param topic_id: The topic to remove.
        :param user_id: The requesting owner; a topic owned by someone else is
            treated as not found.
        :returns: ``True`` if removed, ``False`` if not found / not owned.
        """

    # ── ideas ────────────────────────────────────────────────────────────

    @abstractmethod
    def list_ideas(self, *, user_id: str | None) -> list[Idea]:
        """List an owner's ideas in suggested order.

        :param user_id: Owning person, or ``None`` in single-user mode.
        :returns: The owner's current ideas.
        """

    @abstractmethod
    def replace_ideas(self, *, user_id: str | None, drafts: list[IdeaDraft]) -> list[Idea]:
        """Replace every one of an owner's ideas with a fresh batch, atomically.

        :param user_id: Owning person, or ``None`` in single-user mode.
        :param drafts: The new ideas, in the order they should be listed.
        :returns: The stored ideas, in the same order as ``drafts``.
        """
