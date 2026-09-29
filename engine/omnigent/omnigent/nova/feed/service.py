"""Feed domain logic: posting, following/unfollowing topics, and ideas.

Ported from the TypeScript prototype's ``feed-tools.ts`` / ``muse-feed.ts``
(follow/unfollow, list, post) and ``ideas.ts`` (replace-wholesale). Validation
bounds mirror the prototype's constants.
"""

from __future__ import annotations

from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from omnigent.errors import ErrorCode, OmnigentError
from omnigent.nova._shared import NovaActor, new_id
from omnigent.nova.feed.entities import FeedPost, FollowedTopic, Idea, IdeaDraft, PostKind
from omnigent.nova.feed.store import POST_PAGE_SIZE, FeedStore, PostPage

TOPIC_MAX_CHARS = 200
MAX_FOLLOWED_TOPICS = 20
POST_TITLE_MAX_CHARS = 200
POST_BODY_MAX_CHARS = 2_000
IDEAS_COUNT = 6

# A daily digest hour with no particular significance beyond being a
# reasonable "catch up on what happened overnight" time.
_DIGEST_HOUR_LOCAL = 9


def _clean(value: str, max_chars: int) -> str:
    return value.strip()[:max_chars]


def _is_http_url(value: str) -> bool:
    return value.startswith(("http://", "https://"))


class FeedService:
    """Domain logic over a :class:`FeedStore`, scoped to one :class:`NovaActor` per call."""

    def __init__(self, store: FeedStore) -> None:
        """:param store: The backing store."""
        self._store = store

    # ── posts ────────────────────────────────────────────────────────────

    def post(
        self,
        actor: NovaActor,
        *,
        kind: PostKind,
        title: str,
        body: str,
        goal_id: str | None = None,
        source_url: str | None = None,
    ) -> FeedPost:
        """Write one post: a Goal report or a Followed-topic finding.

        :param actor: Whose feed this is.
        :param kind: ``"goal_report"`` or ``"topic"``.
        :param title: Short headline, trimmed and capped.
        :param body: The finding or report, trimmed and capped.
        :param goal_id: The Goal this reports on, for ``kind="goal_report"``.
        :param source_url: The http(s) source a topic finding cites. Required
            for ``kind="topic"``.
        :returns: The created post.
        :raises OmnigentError: ``INVALID_INPUT`` if ``title``/``body`` is
            empty, or ``kind="topic"`` without a valid http(s) ``source_url``.
        """
        clean_title = _clean(title, POST_TITLE_MAX_CHARS)
        clean_body = _clean(body, POST_BODY_MAX_CHARS)
        if not clean_title:
            raise OmnigentError("title is required.", code=ErrorCode.INVALID_INPUT)
        if not clean_body:
            raise OmnigentError("body is required.", code=ErrorCode.INVALID_INPUT)
        if kind == "topic" and not (source_url and _is_http_url(source_url)):
            raise OmnigentError(
                "source_url must be a valid http(s) URL for a topic post.",
                code=ErrorCode.INVALID_INPUT,
            )
        return self._store.create_post(
            new_id(),
            user_id=actor.user_id,
            kind=kind,
            title=clean_title,
            body=clean_body,
            goal_id=goal_id,
            source_url=source_url,
        )

    def list_posts(
        self, actor: NovaActor, *, cursor: str | None = None, limit: int = POST_PAGE_SIZE
    ) -> PostPage:
        """List an actor's posts, newest first.

        :param actor: Whose feed this is.
        :param cursor: An opaque cursor from a previous page, or ``None``.
        :param limit: Max posts to return.
        :returns: The requested page.
        """
        return self._store.list_posts(user_id=actor.user_id, cursor=cursor, limit=limit)

    # ── followed topics ─────────────────────────────────────────────────

    def list_topics(self, actor: NovaActor) -> list[FollowedTopic]:
        """List an actor's followed topics, oldest-followed first.

        :param actor: Whose topics these are.
        """
        return self._store.list_topics(user_id=actor.user_id)

    def follow_topic(self, actor: NovaActor, topic: str) -> FollowedTopic:
        """Follow a topic, idempotently, up to :data:`MAX_FOLLOWED_TOPICS` per person.

        :param actor: Who is following.
        :param topic: The subject to watch, trimmed and capped.
        :returns: The existing topic if already followed, else the new one.
        :raises OmnigentError: ``INVALID_INPUT`` if ``topic`` is empty or the
            actor already follows :data:`MAX_FOLLOWED_TOPICS` topics.
        """
        clean_topic = _clean(topic, TOPIC_MAX_CHARS)
        if not clean_topic:
            raise OmnigentError("topic is required.", code=ErrorCode.INVALID_INPUT)
        existing = self._store.get_topic_by_name(user_id=actor.user_id, topic=clean_topic)
        if existing is not None:
            return existing
        if self._store.count_topics(user_id=actor.user_id) >= MAX_FOLLOWED_TOPICS:
            raise OmnigentError(
                f"Already following {MAX_FOLLOWED_TOPICS} topics, the most Nova can watch "
                "at once. Unfollow one first.",
                code=ErrorCode.INVALID_INPUT,
            )
        return self._store.create_topic(new_id(), user_id=actor.user_id, topic=clean_topic)

    def unfollow_topic(self, actor: NovaActor, topic_id: str) -> bool:
        """Unfollow a topic by id.

        :param actor: The requesting owner; a topic owned by someone else is
            treated as not found.
        :param topic_id: The topic to remove.
        :returns: ``True`` if removed, ``False`` if not found / not owned.
        """
        return self._store.delete_topic(topic_id, user_id=actor.user_id)

    def unfollow_topic_by_name(self, actor: NovaActor, topic: str) -> bool:
        """Unfollow a topic by its exact text, for the conversational tool.

        :param actor: Who is unfollowing.
        :param topic: The exact topic text to stop following.
        :returns: ``True`` if a matching topic was removed, ``False`` otherwise.
        """
        clean_topic = _clean(topic, TOPIC_MAX_CHARS)
        existing = self._store.get_topic_by_name(user_id=actor.user_id, topic=clean_topic)
        if existing is None:
            return False
        return self._store.delete_topic(existing.id, user_id=actor.user_id)

    # ── ideas ────────────────────────────────────────────────────────────

    def list_ideas(self, actor: NovaActor) -> list[Idea]:
        """List an actor's current ideas, in suggested order.

        :param actor: Whose ideas these are.
        """
        return self._store.list_ideas(user_id=actor.user_id)

    def replace_ideas(self, actor: NovaActor, drafts: list[IdeaDraft]) -> list[Idea]:
        """Replace all of an actor's ideas with a fresh batch.

        :param actor: Whose ideas to replace.
        :param drafts: The new ideas, capped to :data:`IDEAS_COUNT`.
        :returns: The stored ideas, in the same order as ``drafts``.
        """
        return self._store.replace_ideas(user_id=actor.user_id, drafts=drafts[:IDEAS_COUNT])


def digest_schedule(timezone: str) -> str:
    """The daily Followed-topic digest's recurrence rule.

    Pure and side-effect free: it neither reads nor writes a scheduled task,
    it only computes the RRULE a caller would pass to one. See this
    package's README ("Scheduling the daily digest") for the documented plan
    to wire it into Omnigent scheduled tasks — not done by this function.

    :param timezone: The person's IANA timezone, e.g. ``"America/Toronto"``.
        Not embedded in the returned RRULE (a scheduled task carries its own
        ``timezone`` field the rule is evaluated in) — validated here so a
        bad zone is caught before it reaches the scheduler.
    :returns: An RFC 5545 RRULE, e.g. ``"FREQ=DAILY;BYHOUR=9;BYMINUTE=0"``.
    :raises OmnigentError: ``INVALID_INPUT`` if ``timezone`` is not a known
        IANA zone.
    """
    try:
        ZoneInfo(timezone)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise OmnigentError(
            f"Unknown timezone: {timezone!r}", code=ErrorCode.INVALID_INPUT
        ) from exc
    return f"FREQ=DAILY;BYHOUR={_DIGEST_HOUR_LOCAL};BYMINUTE=0"
