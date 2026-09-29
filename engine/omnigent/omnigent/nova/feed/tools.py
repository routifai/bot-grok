"""Nova's feed built-in tools: ``nova_follow_topic``, ``nova_unfollow_topic``,
``nova_post_to_feed``.

Ported from the TypeScript prototype's ``feed-tools.ts``
(``followTopicFromTool`` / ``unfollowTopicFromTool`` / ``addTopicPostFromTool``).
Private scope only (Rule 3, ``../README.md``): each tool resolves the calling
session's owner and scope from ``ToolContext.conversation_id`` via the shared
``ConversationStore`` and refuses outside a private session.

These run in-process (this package has no runner-dispatch counterpart), so
``invoke`` does the real work directly rather than only carrying a schema.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable
from typing import Any

from omnigent.errors import OmnigentError
from omnigent.nova import feed as _feed
from omnigent.nova._shared import private_actor
from omnigent.nova.feed.service import FeedService
from omnigent.tools.base import Tool, ToolContext

_logger = logging.getLogger(__name__)


def _service() -> FeedService:
    """The feed service used where no ``NovaDeps`` is available (i.e. here)."""
    return FeedService(_feed._runtime_store())


class NovaFollowTopicTool(Tool):
    """Follow a topic for the daily digest to research."""

    @classmethod
    def name(cls) -> str:
        return "nova_follow_topic"

    @classmethod
    def description(cls) -> str:
        return (
            "Follow a topic so Nova's daily digest researches it and posts findings to "
            "the feed. Use this when the person asks you to keep an eye on something "
            "('follow AI in banking news', 'watch for updates on X')."
        )

    def get_schema(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name(),
                "description": self.description(),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "topic": {
                            "type": "string",
                            "description": "The subject to watch, e.g. 'AI in banking news'.",
                        },
                    },
                    "required": ["topic"],
                    "additionalProperties": False,
                },
            },
        }

    def invoke(self, arguments: str, ctx: ToolContext) -> str:
        actor, refusal = private_actor(ctx.conversation_id)
        if refusal is not None:
            return f"Error: {refusal}"
        assert actor is not None
        try:
            topic = json.loads(arguments).get("topic") if arguments else None
            if not topic:
                return "Error: 'topic' parameter is required."
            followed = _service().follow_topic(actor, topic)
            return f'Now following "{followed.topic}".'
        except OmnigentError as e:
            return f"Error: {e}"
        except Exception as e:  # noqa: BLE001 — tool results are strings, never raise to the LLM
            _logger.error("nova_follow_topic failed: %s", e)
            return f"nova_follow_topic failed: {e}"


class NovaUnfollowTopicTool(Tool):
    """Stop following a topic."""

    @classmethod
    def name(cls) -> str:
        return "nova_unfollow_topic"

    @classmethod
    def description(cls) -> str:
        return "Stop following a topic the person previously asked Nova to watch."

    def get_schema(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name(),
                "description": self.description(),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "topic": {
                            "type": "string",
                            "description": "The exact topic text to stop following.",
                        },
                    },
                    "required": ["topic"],
                    "additionalProperties": False,
                },
            },
        }

    def invoke(self, arguments: str, ctx: ToolContext) -> str:
        actor, refusal = private_actor(ctx.conversation_id)
        if refusal is not None:
            return f"Error: {refusal}"
        assert actor is not None
        try:
            topic = json.loads(arguments).get("topic") if arguments else None
            if not topic:
                return "Error: 'topic' parameter is required."
            removed = _service().unfollow_topic_by_name(actor, topic)
            if not removed:
                return f'Not following "{topic}".'
            return f'Stopped following "{topic}".'
        except Exception as e:  # noqa: BLE001
            _logger.error("nova_unfollow_topic failed: %s", e)
            return f"nova_unfollow_topic failed: {e}"


class NovaPostToFeedTool(Tool):
    """Post a Followed-topic finding to the feed."""

    @classmethod
    def name(cls) -> str:
        return "nova_post_to_feed"

    @classmethod
    def description(cls) -> str:
        return (
            "Post a Followed-topic finding to the person's feed. Call this only during a "
            "Followed-topic research turn, once per finding worth telling the person about, "
            "with a real source you found via a tool call. Never invent a finding or a "
            "source URL."
        )

    def get_schema(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name(),
                "description": self.description(),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "title": {"type": "string", "description": "A short headline."},
                        "body": {
                            "type": "string",
                            "description": "A one-to-three sentence summary of the finding.",
                        },
                        "source_url": {
                            "type": "string",
                            "description": "The http(s) URL the finding was found at.",
                        },
                    },
                    "required": ["title", "body", "source_url"],
                    "additionalProperties": False,
                },
            },
        }

    def invoke(self, arguments: str, ctx: ToolContext) -> str:
        actor, refusal = private_actor(ctx.conversation_id)
        if refusal is not None:
            return f"Error: {refusal}"
        assert actor is not None
        try:
            parsed = json.loads(arguments) if arguments else {}
            post = _service().post(
                actor,
                kind="topic",
                title=parsed.get("title", ""),
                body=parsed.get("body", ""),
                source_url=parsed.get("source_url"),
            )
            return f'Posted "{post.title}" to the feed.'
        except OmnigentError as e:
            return f"Error: {e}"
        except Exception as e:  # noqa: BLE001
            _logger.error("nova_post_to_feed failed: %s", e)
            return f"nova_post_to_feed failed: {e}"


TOOLS: dict[str, Callable[[dict[str, str]], Tool]] = {
    "nova_follow_topic": lambda _config: NovaFollowTopicTool(),
    "nova_unfollow_topic": lambda _config: NovaUnfollowTopicTool(),
    "nova_post_to_feed": lambda _config: NovaPostToFeedTool(),
}
