"""Runner-side handlers for the card tools: validated and returned in-process, no server hop."""

from __future__ import annotations

import json
from typing import Any

from omnigent.superchat.cards.tools import build_card, build_clarification, build_follow_ups
from omnigent.superchat.feature import HandlerCtx


async def handle_card_tool(_ctx: HandlerCtx, args: dict[str, Any]) -> str:
    """
    Validate and echo a reply card.

    :param _ctx: The call context (unused).
    :param args: Parsed tool arguments.
    :returns: The card as a JSON string.
    """
    return json.dumps(build_card(args), ensure_ascii=False)


async def handle_clarification_tool(_ctx: HandlerCtx, args: dict[str, Any]) -> str:
    """:returns: The ``ask`` card for an ``ask_clarification`` call, as a JSON string."""
    return json.dumps(build_clarification(args), ensure_ascii=False)


async def handle_follow_ups_tool(_ctx: HandlerCtx, args: dict[str, Any]) -> str:
    """:returns: The ``follow_ups`` card for a ``suggest_follow_ups`` call, as a JSON string."""
    return json.dumps(build_follow_ups(args), ensure_ascii=False)
