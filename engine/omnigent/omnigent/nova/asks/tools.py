"""Built-in tool: ask the person a short question and wait for their pick.

Ports ``ask_user`` from Nova's TypeScript prototype
(``packages/adapters/src/builtin-tools.ts`` and ``pi-runtime.ts``): one short
question, two to four short tappable options, and the turn ends waiting for
the person's answer — the model should not keep talking past this call.
Private scope only (README rule 3): the tool is inert outside the person's
own session, since there is no "Waiting on you" surface to answer it from.
"""

from __future__ import annotations

import json
from typing import Any

from omnigent.errors import OmnigentError
from omnigent.nova import asks as _asks
from omnigent.nova._shared import NovaActor, Scope, scope_from_labels
from omnigent.nova.asks.entities import AskAction, AskKind
from omnigent.tools.base import Tool, ToolContext

_NAME = "nova_ask_user"
_MAX_QUESTION_LEN = 240
_MAX_OPTION_LEN = 80
_MIN_OPTIONS = 2
_MAX_OPTIONS = 4

_DESCRIPTION = (
    "Ask the person one short question with two to four tappable options, then wait "
    "for their pick. Use it whenever you would otherwise end your reply with a "
    "question: a missing detail, a choice between approaches, or offering the next "
    "step you could take. Keep the question under a sentence and each option a few "
    "words. Ends your turn — do not keep talking after calling this; the person "
    'answers from "Waiting on you".'
)

_SCHEMA: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": _NAME,
        "description": _DESCRIPTION,
        "parameters": {
            "type": "object",
            "properties": {
                "question": {"type": "string", "maxLength": _MAX_QUESTION_LEN},
                "options": {
                    "type": "array",
                    "items": {"type": "string", "minLength": 1, "maxLength": _MAX_OPTION_LEN},
                    "minItems": _MIN_OPTIONS,
                    "maxItems": _MAX_OPTIONS,
                    "uniqueItems": True,
                },
            },
            "required": ["question", "options"],
        },
    },
}


def _validate(question: Any, options: Any) -> str | None:
    """Validate raw tool arguments; returns an error message, or ``None`` if valid."""
    if not isinstance(question, str) or not question.strip():
        return "question is required"
    if len(question) > _MAX_QUESTION_LEN:
        return f"question must be at most {_MAX_QUESTION_LEN} characters"
    if not isinstance(options, list) or not all(isinstance(o, str) for o in options):
        return "options must be a list of strings"
    stripped = [o.strip() for o in options]
    if not (_MIN_OPTIONS <= len(stripped) <= _MAX_OPTIONS):
        return f"options must have {_MIN_OPTIONS} to {_MAX_OPTIONS} entries"
    if any(not o or len(o) > _MAX_OPTION_LEN for o in stripped):
        return f"each option must be 1 to {_MAX_OPTION_LEN} characters"
    if len(set(stripped)) != len(stripped):
        return "options must be unique"
    return None


class NovaAskUserTool(Tool):
    """Records an Ask and tells the model to stop and wait for the person's choice."""

    @classmethod
    def name(cls) -> str:
        """:returns: ``"nova_ask_user"``."""
        return _NAME

    @classmethod
    def description(cls) -> str:
        """:returns: Human-readable description of the tool."""
        return _DESCRIPTION

    def get_schema(self) -> dict[str, Any]:
        """:returns: The OpenAI-format tool schema."""
        return _SCHEMA

    def invoke(self, arguments: str, ctx: ToolContext) -> str:
        """Validate the question/options, open an Ask, and tell the model to wait.

        :param arguments: JSON with ``"question"`` and ``"options"``.
        :param ctx: Server-side execution context; ``conversation_id`` is
            required — this tool has no session-independent meaning.
        :returns: JSON string: ``{"error": ...}`` on any validation or
            privacy failure, else ``{"status": "waiting_for_answer", ...}``.
        """
        # Lazy: omnigent.tools.builtins.__init__ itself pulls in every Nova
        # primitive's TOOLS (see that module) to build the builtin registry,
        # so importing from it at module load time here would be circular.
        from omnigent.tools.builtins._arguments import parse_json_object_arguments

        args, error = parse_json_object_arguments(arguments)
        if error is not None:
            return json.dumps({"error": error})
        assert args is not None
        question, options = args.get("question"), args.get("options")
        error = _validate(question, options)
        if error is not None:
            return json.dumps({"error": error})
        assert isinstance(question, str)
        assert isinstance(options, list)

        actor, refusal = _resolve_private_actor(ctx)
        if refusal is not None:
            return json.dumps({"error": refusal})
        assert actor is not None

        actions = tuple(
            AskAction(id=f"choice-{index + 1}", label=label.strip())
            for index, label in enumerate(options)
        )
        try:
            _asks._runtime_service().open_ask(
                actor=actor,
                kind=AskKind.QUESTION,
                text=question.strip(),
                actions=actions,
                session_id=ctx.conversation_id,
            )
        except OmnigentError as exc:
            return json.dumps({"error": str(exc)})
        return json.dumps(
            {"status": "waiting_for_answer", "message": "Waiting for the person's choice."}
        )


def _resolve_private_actor(ctx: ToolContext) -> tuple[NovaActor | None, str | None]:
    """Resolve the calling session's owner as a :class:`NovaActor`.

    Mirrors ``_resolve_private_actor`` in ``omnigent/nova/memory/tools.py``
    (not yet lifted into ``_shared`` — duplicated here until the maintainer
    moves it): same identity resolution (a conversation id's owner via the
    conversation store's ``get_session_owner``, the grant Omnigent already
    uses to attribute session cost) and the same private-scope refusal a
    built-in tool needs but a route never does.

    :param ctx: The tool's execution context.
    :returns: ``(actor, None)`` on success, or ``(None, reason)`` — a reason
        the tool should return as its ``"error"`` — on refusal.
    """
    if ctx.conversation_id is None:
        return None, "no active session to ask from"

    from omnigent.db.db_models import current_workspace_id
    from omnigent.runtime import get_conversation_store

    conversation_store = get_conversation_store()
    conversation = conversation_store.get_conversation(ctx.conversation_id)
    if conversation is None:
        return None, "session not found"
    if scope_from_labels(conversation.labels or {}) is not Scope.PRIVATE:
        return None, "nova_ask_user is only available in a private session"

    owner = conversation_store.get_session_owner(ctx.conversation_id)
    if owner is None:
        return None, "session has no owner"
    return NovaActor(user_id=owner, workspace_id=current_workspace_id()), None


def _create(config: dict[str, str]) -> Tool:
    """Factory for :class:`NovaAskUserTool`.

    :param config: Tool config (unused).
    :returns: A fresh :class:`NovaAskUserTool` instance.
    """
    del config
    return NovaAskUserTool()


TOOLS: dict[str, Any] = {_NAME: _create}
