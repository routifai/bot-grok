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

from omnigent.nova._shared import NovaActor, Scope, scope_from_labels
from omnigent.nova.episodes import _runtime
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
        :param store: The episode store to read from; defaults to the store
            ``routes.create_router`` configured at startup. Tests pass one
            explicitly instead of relying on that global.
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

        actor, refusal = _resolve_private_actor(ctx)
        if refusal is not None:
            return json.dumps({"error": refusal})
        assert actor is not None

        store = self._store or _runtime.store()
        if store is None:
            return json.dumps({"error": "episodes are not available on this server"})

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


def _resolve_private_actor(ctx: ToolContext) -> tuple[NovaActor | None, str | None]:
    """Resolve the calling session's owner as a :class:`NovaActor`.

    Mirrors ``omnigent.nova.memory.tools._resolve_private_actor`` — the same
    identity resolution (a conversation id to its owner via the conversation
    store's ``get_session_owner``, plus the private-scope check a route never
    needs) every tool that reads or writes owner-scoped state from inside a
    running session repeats. Not yet a shared helper in ``_shared``.

    :param ctx: The tool's execution context.
    :returns: ``(actor, None)`` on success, or ``(None, reason)`` — a reason
        the tool should return as its ``"error"`` — on refusal.
    """
    if ctx.conversation_id is None:
        return None, "nova_recall_episodes requires a session"

    from omnigent.db.db_models import current_workspace_id
    from omnigent.runtime import get_conversation_store

    conversation_store = get_conversation_store()
    conversation = conversation_store.get_conversation(ctx.conversation_id)
    if conversation is None:
        return None, "session not found"
    if scope_from_labels(conversation.labels) is not Scope.PRIVATE:
        return None, "nova_recall_episodes only runs in a private Nova session"

    owner = conversation_store.get_session_owner(ctx.conversation_id)
    if owner is None:
        return None, "session has no owner"
    return NovaActor(user_id=owner, workspace_id=current_workspace_id()), None


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
