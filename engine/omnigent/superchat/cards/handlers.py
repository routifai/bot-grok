"""Runner-side handlers for the card tools: validated and returned in-process, no server hop."""

from __future__ import annotations

import json
import uuid
from typing import Any

from omnigent.superchat.cards.tools import build_card, build_clarification, build_follow_ups
from omnigent.superchat.feature import HandlerCtx
from omnigent.superchat.tasks.runtime import current_task


async def handle_card_tool(_ctx: HandlerCtx, args: dict[str, Any]) -> str:
    """
    Validate and echo a reply card. A ``plan`` card with no ``id`` gets one, so the engine's
    record of it (ADR 0027) and the transcript name the same plan.

    :param _ctx: The call context (unused).
    :param args: Parsed tool arguments.
    :returns: The card as a JSON string.
    """
    if args.get("card") == "plan" and not args.get("id"):
        args = {**args, "id": f"plan-{uuid.uuid4().hex}"}
    return json.dumps(build_card(args), ensure_ascii=False)


async def handle_clarification_tool(ctx: HandlerCtx, args: dict[str, Any]) -> str:
    """:returns: The ``ask`` card for an ``ask_clarification`` call, as a JSON string, naming
    the task the Conversation's turn works on."""
    card = build_clarification(args, current_task(ctx.conversation_id), f"ask-{uuid.uuid4().hex}")
    return json.dumps(card, ensure_ascii=False)


async def handle_follow_ups_tool(_ctx: HandlerCtx, args: dict[str, Any]) -> str:
    """:returns: The ``follow_ups`` card for a ``suggest_follow_ups`` call, as a JSON string."""
    return json.dumps(build_follow_ups(args), ensure_ascii=False)
