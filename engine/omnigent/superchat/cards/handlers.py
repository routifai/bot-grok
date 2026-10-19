"""Runner-side handlers for the card tools: validated and returned in-process, no server hop."""

from __future__ import annotations

import json
import uuid
from typing import Any

from omnigent.superchat.cards.tools import (
    TERMINAL_CARDS,
    build_card,
    build_clarification,
    build_follow_ups,
)
from omnigent.superchat.feature import HandlerCtx
from omnigent.superchat.tasks.runtime import current_round

#: What a reply card or chips get when the turn has written no words yet: a card alone leaves
#: the person without a sentence (the model skips it after a Helper's wake, whatever the prompt
#: says), so it is sent back once per turn to say something first.
SAY_FIRST = {
    "error": "say_first",
    "message": (
        "Before showing this, write one or two plain sentences saying what it is and anything "
        "still open; then call the tool again with the same arguments."
    ),
}
#: Conversations whose running turn already had its one ``say_first``; cleared at turn end.
_told: set[str] = set()


def _say_first(ctx: HandlerCtx) -> str | None:
    """``SAY_FIRST`` for a turn's first wordless reply card or chips, else ``None``."""
    if ctx.turn_said is not False or ctx.conversation_id is None:
        return None
    if ctx.conversation_id in _told:
        return None  # the second call is taken as it is: never a loop
    _told.add(ctx.conversation_id)
    return json.dumps(SAY_FIRST)


def turn_ended(conversation_id: str) -> None:
    """Forget the turn's ``say_first`` (``Feature.on_turn_end``)."""
    _told.discard(conversation_id)


async def handle_card_tool(ctx: HandlerCtx, args: dict[str, Any]) -> str:
    """
    Validate and echo a reply card; a terminal card the turn wrote no words before is sent
    back once (:data:`SAY_FIRST`). Progress cards are shown mid-work and never are.

    :param ctx: The call context.
    :param args: Parsed tool arguments.
    :returns: The card as a JSON string.
    """
    card = build_card(args)
    if card.get("card") in TERMINAL_CARDS and (refusal := _say_first(ctx)) is not None:
        return refusal
    return json.dumps(card, ensure_ascii=False)


async def handle_clarification_tool(ctx: HandlerCtx, args: dict[str, Any]) -> str:
    """:returns: The ``ask`` card for an ``ask_clarification`` call, as a JSON string, naming
    the Round the Conversation's turn is in."""
    card = build_clarification(args, current_round(ctx.conversation_id), f"ask-{uuid.uuid4().hex}")
    return json.dumps(card, ensure_ascii=False)


async def handle_follow_ups_tool(ctx: HandlerCtx, args: dict[str, Any]) -> str:
    """:returns: The ``follow_ups`` card for a ``suggest_follow_ups`` call, as a JSON string;
    :data:`SAY_FIRST` once when the turn would otherwise end with chips and no words."""
    card = build_follow_ups(args)
    if "error" not in card and (refusal := _say_first(ctx)) is not None:
        return refusal
    return json.dumps(card, ensure_ascii=False)
