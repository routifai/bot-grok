"""The ``nova_recall_episodes`` built-in tool.

Ported from Muse's ``recall_episodes`` adapter tool
(packages/adapters/src/muse/episodes.ts): keyword-ranks the person's most
recent episodes against ``query`` and returns the top matches, falling back to
the most recent episodes when nothing matches so the tool never comes back
empty when Nova has clearly done work for this person before.
"""

from __future__ import annotations

import datetime
import json
from typing import Any

from omnigent.nova import episodes as _episodes
from omnigent.nova._shared import private_actor
from omnigent.nova.episodes.entities import Episode
from omnigent.nova.episodes.service import rank_episodes
from omnigent.nova.episodes.store import EpisodeStore
from omnigent.tools.base import Tool, ToolContext

# How many of the person's most recent episodes a recall searches over.
_LOOKBACK_EPISODES = 1000
_DEFAULT_LIMIT = 5
_MIN_LIMIT = 1
_MAX_LIMIT = 10


class NovaRecallEpisodesTool(Tool):
    """Recall past episodes relevant to a query, private sessions only."""

    def __init__(self, store: EpisodeStore | None = None) -> None:
        """
        :param store: The episode store to read from; defaults to this
            primitive's shared runtime store. Tests pass one explicitly
            instead of relying on that global.
        """
        self._store = store

    @classmethod
    def name(cls) -> str:
        """:returns: ``"nova_recall_episodes"``."""
        return "nova_recall_episodes"

    @classmethod
    def description(cls) -> str:
        """:returns: Human-readable description of the tool."""
        return (
            "Recall past tasks you did for this person. Use this to check "
            "whether you have done something like this before, or to find "
            "details from a past task (decisions made, links found, tools "
            "used)."
        )

    def get_schema(self) -> dict[str, Any]:
        """:returns: The OpenAI-format tool schema."""
        return {
            "type": "function",
            "function": {
                "name": self.name(),
                "description": self.description(),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Keywords describing the past task to recall.",
                        },
                        "limit": {
                            "type": "integer",
                            "description": (
                                f"Maximum number of episodes to return "
                                f"({_MIN_LIMIT}-{_MAX_LIMIT}). Default {_DEFAULT_LIMIT}."
                            ),
                        },
                    },
                    "required": ["query"],
                },
            },
        }

    def invoke(self, arguments: str, ctx: ToolContext) -> str:
        """Rank the person's recent episodes against ``query``.

        :param arguments: JSON with ``"query"`` and optional ``"limit"`` keys.
        :param ctx: Server-side execution context; ``ctx.conversation_id``
            identifies the session to resolve the caller and its scope from.
        :returns: JSON string with ``{"episodes": [...]}``, or an
            ``{"error": ...}`` when the tool cannot run here.
        """
        # Imported here, not at module level: omnigent.tools.builtins.__init__
        # imports omnigent.nova.episodes.tools to register this very tool (see
        # _registry.tools()), so a top-level import back into
        # omnigent.tools.builtins would be circular whenever this module is
        # the first of the two to load.
        from omnigent.tools.builtins._arguments import parse_json_object_arguments

        args, error = parse_json_object_arguments(arguments)
        if error is not None:
            return json.dumps({"error": error})
        assert args is not None

        actor, refusal = private_actor(ctx.conversation_id)
        if refusal is not None:
            return json.dumps({"error": refusal})
        assert actor is not None

        store = self._store or _episodes._runtime_store()

        query = str(args.get("query", "")).strip()
        limit = _clamp_limit(args.get("limit"))

        episodes = store.list_recent(actor=actor, limit=_LOOKBACK_EPISODES)
        ranked = rank_episodes(query, episodes, limit=limit) if query else []
        if ranked:
            return json.dumps({"episodes": [_to_recall_item(e) for e in ranked]})

        recent = episodes[:_DEFAULT_LIMIT]
        note = (
            "No episodes matched that query; showing the most recent instead."
            if recent
            else "No past episodes yet."
        )
        return json.dumps({"episodes": [_to_recall_item(e) for e in recent], "note": note})


def _clamp_limit(limit: Any) -> int:
    if not isinstance(limit, int) or isinstance(limit, bool):
        return _DEFAULT_LIMIT
    return min(_MAX_LIMIT, max(_MIN_LIMIT, limit))


def _to_recall_item(episode: Episode) -> dict[str, Any]:
    date = datetime.datetime.fromtimestamp(episode.created_at, tz=datetime.UTC).strftime(
        "%Y-%m-%d"
    )
    return {
        "date": date,
        "title": episode.title,
        "summary": episode.summary,
        "links": list(episode.links),
    }


def _create_recall_episodes(config: dict[str, str]) -> Tool:
    """
    Lazy factory for :class:`NovaRecallEpisodesTool`.

    :param config: Tool config (unused).
    :returns: A :class:`NovaRecallEpisodesTool` instance.
    """
    del config
    return NovaRecallEpisodesTool()


TOOLS: dict[str, Any] = {"nova_recall_episodes": _create_recall_episodes}
