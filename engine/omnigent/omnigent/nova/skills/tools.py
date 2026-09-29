"""Built-in tools: offer, save, and load a skill.

Ports ``offer_skill`` / ``skill_create`` / ``skill_read`` from Nova's
TypeScript prototype (``packages/adapters/src/muse/skill-offer.ts``,
``packages/adapters/src/skill-tools.ts``), keyed by the person instead of a
bot. Private scope only (``nova/README.md`` rule 3): a shared/project session
has no single owner whose skills it would be safe to read or write.
"""

from __future__ import annotations

import json
from typing import Any

from omnigent.errors import OmnigentError
from omnigent.nova import skills as _skills
from omnigent.nova._shared import private_actor
from omnigent.nova.skills import gate
from omnigent.tools.base import Tool, ToolContext

_MAX_NAME_LEN = _skills.NAME_MAX_CHARS
_MAX_DESCRIPTION_LEN = _skills.DESCRIPTION_MAX_CHARS
_REASON_VALUES = ("repeated", "asked", "corrected")


class NovaOfferSkillTool(Tool):
    """Offers to save a just-finished multi-step task as a skill.

    Posts a Save / Not now card; nothing is saved until the person accepts
    it. The only way to offer a skill — the model should never ask about
    saving one in its reply text.
    """

    @classmethod
    def name(cls) -> str:
        """:returns: ``"nova_offer_skill"``."""
        return "nova_offer_skill"

    @classmethod
    def description(cls) -> str:
        """:returns: Human-readable description of the tool."""
        return (
            "Offer to save what you just did as a reusable skill; this is the only way to "
            "offer one (never ask about saving a skill in your reply text). Call it once, "
            "after finishing a multi-step task successfully, when the body is a real "
            "procedure the person is likely to run again — never for a one-off question or "
            "right after tool errors. The body needs a 'Steps'/'Procedure' heading with at "
            "least 3 concrete steps and a 'When to use' line, or the offer is refused. You "
            "also need evidence they'd reuse it: similar past work, or them explicitly asking "
            "you to remember/learn this (set 'reason'). Shows a Save / Not now card, or an "
            "update card if this looks like an existing skill; nothing is saved unless they "
            "choose Save. End your reply briefly — don't restate the offer."
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
                        "name": {
                            "type": "string",
                            "maxLength": _MAX_NAME_LEN,
                            "description": "Short skill name, e.g. 'Weekly status report'.",
                        },
                        "description": {
                            "type": "string",
                            "maxLength": _MAX_DESCRIPTION_LEN,
                            "description": "One line: when to use this skill.",
                        },
                        "body": {
                            "type": "string",
                            "description": (
                                "The generic steps, as SKILL.md markdown: a 'Steps' or "
                                "'Procedure' heading with at least 3 numbered/bulleted steps, "
                                "plus a 'When to use' line. No account names."
                            ),
                        },
                        "reason": {
                            "type": "string",
                            "enum": list(_REASON_VALUES),
                            "description": (
                                "Why you're offering this now: 'repeated' (you've done this "
                                "for them before), 'asked' (they asked you to remember/learn "
                                "it), or 'corrected' (they corrected you with how to do it next "
                                "time). Omit if none apply."
                            ),
                        },
                    },
                    "required": ["name", "description", "body"],
                },
            },
        }

    def invoke(self, arguments: str, ctx: ToolContext) -> str:
        """
        Open a skill offer for the resolved owner.

        :param arguments: JSON with ``"name"``, ``"description"``, ``"body"``,
            and optional ``"reason"``.
        :param ctx: Execution context; ``conversation_id`` identifies the
            session whose owner is offered the skill.
        :returns: JSON ``{"status": "offer_shown", ...}``, or ``{"error": ...}``.
        """
        # Imported here, not at module level: omnigent.tools.builtins.__init__
        # imports omnigent.nova.skills.tools to register these tools (see
        # _registry.tools()), so a top-level import back into
        # omnigent.tools.builtins would be circular.
        from omnigent.tools.builtins._arguments import parse_json_object_arguments

        args, error = parse_json_object_arguments(arguments)
        if error is not None:
            return json.dumps({"error": error})
        assert args is not None

        name, description, body = args.get("name"), args.get("description"), args.get("body")
        if not isinstance(name, str) or not name.strip():
            return json.dumps({"error": "missing required 'name' argument"})
        if not isinstance(description, str) or not description.strip():
            return json.dumps({"error": "missing required 'description' argument"})
        if not isinstance(body, str):
            return json.dumps({"error": "'body' must be a string"})
        reason = args.get("reason")
        if reason is not None and reason not in _REASON_VALUES:
            reason = None

        actor, refusal = private_actor(ctx.conversation_id)
        if refusal is not None:
            return json.dumps({"error": refusal})
        assert actor is not None

        turn_failed, latest_user_message = _read_turn_signals(ctx.conversation_id)

        try:
            offer = _skills._runtime_service().offer(
                actor,
                name=name,
                description=description,
                body=body,
                reason=reason,
                turn_failed=turn_failed,
                latest_user_message=latest_user_message,
            )
        except OmnigentError as exc:
            return json.dumps({"error": str(exc)})
        return json.dumps(
            {
                "status": "offer_shown",
                "offer_kind": offer.offer_kind.value,
                "target_skill": offer.target_skill,
                "message": "Offer card shown to the person. Keep your reply brief.",
            }
        )


def _read_turn_signals(conversation_id: str | None) -> tuple[bool, str]:
    """This turn's failure signal and triggering user message, for the offer gate.

    Best-effort: a session with no conversation store reachable (should not
    happen once ``private_actor`` above already succeeded) is treated as not
    failing, never as a reason to crash the tool call.

    :param conversation_id: The session to read, already known non-``None``.
    :returns: ``(turn_failed, latest_user_message)`` — see :func:`gate.turn_is_failing`.
    """
    from omnigent.runtime import get_conversation_store

    assert conversation_id is not None
    items = get_conversation_store().list_items(
        conversation_id, limit=gate.TURN_LOOKBACK_ITEMS, order="desc"
    )
    signals = gate.read_turn_signals(items.data)
    return gate.turn_is_failing(signals.tool_results), signals.latest_user_message


class NovaSaveSkillTool(Tool):
    """Saves a skill directly: no offer card, used when the person hands it over themselves."""

    @classmethod
    def name(cls) -> str:
        """:returns: ``"nova_save_skill"``."""
        return "nova_save_skill"

    @classmethod
    def description(cls) -> str:
        """:returns: Human-readable description of the tool."""
        return (
            "Save a skill directly, with no offer card: use when the person pastes their "
            "own steps or a full SKILL.md and asks you to keep it. Provide either "
            "'content' (a complete SKILL.md with YAML frontmatter) or 'name' and "
            "'description' (and optional 'body'). Never call this for an offer you made "
            "with nova_offer_skill — that is saved only if they choose Save."
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
                        "content": {
                            "type": "string",
                            "description": "A complete SKILL.md document, frontmatter included.",
                        },
                        "name": {"type": "string", "maxLength": _MAX_NAME_LEN},
                        "description": {"type": "string", "maxLength": _MAX_DESCRIPTION_LEN},
                        "body": {"type": "string", "description": "The steps, as markdown."},
                    },
                },
            },
        }

    def invoke(self, arguments: str, ctx: ToolContext) -> str:
        """
        Save a skill for the resolved owner.

        :param arguments: JSON with either ``"content"`` or ``"name"``/
            ``"description"``/``"body"``.
        :param ctx: Execution context; ``conversation_id`` identifies the
            session whose owner the skill is saved for.
        :returns: JSON ``{"ok": true, "name": ...}``, or ``{"error": ...}``.
        """
        from omnigent.tools.builtins._arguments import parse_json_object_arguments

        args, error = parse_json_object_arguments(arguments)
        if error is not None:
            return json.dumps({"error": error})
        assert args is not None

        actor, refusal = private_actor(ctx.conversation_id)
        if refusal is not None:
            return json.dumps({"error": refusal})
        assert actor is not None

        try:
            skill = _skills._runtime_service().save(
                actor,
                name=args.get("name"),
                description=args.get("description"),
                body=args.get("body"),
                content=args.get("content"),
            )
        except OmnigentError as exc:
            return json.dumps({"error": str(exc)})
        return json.dumps({"ok": True, "name": skill.name})


class NovaLoadSkillTool(Tool):
    """Returns the full body of one of the person's saved skills, by name."""

    @classmethod
    def name(cls) -> str:
        """:returns: ``"nova_load_skill"``."""
        return "nova_load_skill"

    @classmethod
    def description(cls) -> str:
        """:returns: Human-readable description of the tool."""
        return "Load one of the person's saved skills by its exact name, then follow it."

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
                        "name": {"type": "string", "description": "The skill's exact name."},
                    },
                    "required": ["name"],
                },
            },
        }

    def invoke(self, arguments: str, ctx: ToolContext) -> str:
        """
        Look up one of the resolved owner's skills by name.

        :param arguments: JSON with ``"name"``.
        :param ctx: Execution context; ``conversation_id`` identifies whose
            skills are searched.
        :returns: JSON ``{"ok": true, "name": ..., "content": ...}``, or
            ``{"error": ...}`` when missing, invalid, or refused.
        """
        from omnigent.tools.builtins._arguments import parse_json_object_arguments

        args, error = parse_json_object_arguments(arguments)
        if error is not None:
            return json.dumps({"error": error})
        assert args is not None

        name = args.get("name")
        if not isinstance(name, str) or not name.strip():
            return json.dumps({"error": "missing required 'name' argument"})

        actor, refusal = private_actor(ctx.conversation_id)
        if refusal is not None:
            return json.dumps({"error": refusal})
        assert actor is not None

        skill = _skills._runtime_service().get(actor, name)
        if skill is None:
            return json.dumps({"error": f"skill {name!r} not found"})
        return json.dumps({"ok": True, "name": skill.name, "content": skill.content})


def _create_offer_skill(config: dict[str, str]) -> Tool:
    """Factory for :class:`NovaOfferSkillTool`."""
    del config
    return NovaOfferSkillTool()


def _create_save_skill(config: dict[str, str]) -> Tool:
    """Factory for :class:`NovaSaveSkillTool`."""
    del config
    return NovaSaveSkillTool()


def _create_load_skill(config: dict[str, str]) -> Tool:
    """Factory for :class:`NovaLoadSkillTool`."""
    del config
    return NovaLoadSkillTool()


TOOLS = {
    "nova_offer_skill": _create_offer_skill,
    "nova_save_skill": _create_save_skill,
    "nova_load_skill": _create_load_skill,
}
