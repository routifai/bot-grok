"""Domain types for Nova's feed: what it tells the person while they're away.

Ported from the TypeScript prototype's Post / FollowedTopic / Idea models
(``packages/db/src/feed.ts``, ``packages/db/src/ideas.ts``). Workspace is an
ambient DB partition concern (see ``tables.py`` / ``current_workspace_id``),
not a domain field — these entities carry only ``id`` and ``user_id``,
matching :class:`omnigent.entities.Project`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

PostKind = Literal["goal_report", "topic"]
"""A Post is either a report of what Nova did on a Goal, or a Followed-topic finding."""


@dataclass(frozen=True)
class FeedPost:
    """One item in the feed: a Goal report or a Followed-topic finding.

    :param id: 32-char hex id.
    :param user_id: The person this post belongs to, or ``None`` in
        single-user mode.
    :param kind: ``"goal_report"`` or ``"topic"``.
    :param title: Short headline.
    :param body: One to a few sentences of the finding or report.
    :param goal_id: The Goal this reports on, for ``kind="goal_report"``.
        ``None`` for a topic post.
    :param source_url: The http(s) URL a topic finding was found at. Required
        for ``kind="topic"``; ``None`` for a goal report.
    :param created_at: Unix epoch seconds.
    """

    id: str
    user_id: str | None
    kind: PostKind
    title: str
    body: str
    goal_id: str | None
    source_url: str | None
    created_at: int


@dataclass(frozen=True)
class FollowedTopic:
    """A subject the person asked Nova to keep an eye on.

    :param id: 32-char hex id.
    :param user_id: The person following this topic, or ``None`` in
        single-user mode.
    :param topic: The followed subject, e.g. ``"AI in banking news"``.
    :param created_at: Unix epoch seconds; topics list oldest-followed first.
    """

    id: str
    user_id: str | None
    topic: str
    created_at: int


@dataclass(frozen=True)
class Idea:
    """A suggestion of something the person could ask Nova next.

    Always replaced wholesale on refresh — there is no partial update.

    :param id: 32-char hex id.
    :param user_id: The person this idea is for, or ``None`` in single-user
        mode.
    :param text: Short first-person title, e.g. "I can draft that email".
    :param area: One-word grouping label, e.g. ``"travel"``.
    :param detail: 1-3 sentence explanation of what Nova would do.
    :param illustration: Optional bundled illustration key for the client.
    :param created_at: Unix epoch seconds; ideas list in the order suggested.
    """

    id: str
    user_id: str | None
    text: str
    area: str
    detail: str | None
    illustration: str | None
    created_at: int


@dataclass(frozen=True)
class IdeaDraft:
    """One model-suggested idea, before it is assigned an id and stored.

    :param text: Short first-person title.
    :param area: One-word grouping label.
    :param detail: 1-3 sentence explanation, or ``None``.
    :param illustration: Optional bundled illustration key.
    """

    text: str
    area: str
    detail: str | None = None
    illustration: str | None = None
