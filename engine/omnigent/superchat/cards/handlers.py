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
        "Not shown: this turn has no words for the person yet. This is the hand-back, the one "
        "place where you write between tool calls: reply now with one or two plain sentences "
        "saying what was made and anything still open, then call the tool again with the same "
        "arguments."
    ),
}
#: How many wordless cards or chips a turn has sent back; past :data:`_MAX_SAY_FIRST` the next
#: is taken as it is, so it never loops. Cleared at turn end.
_told: dict[str, int] = {}
_MAX_SAY_FIRST = 2


def _say_first(ctx: HandlerCtx) -> str | None:
    """``SAY_FIRST`` while the turn has written no words (at most :data:`_MAX_SAY_FIRST` times),
    else ``None``. A model that batches the card and the chips gets both sent back."""
    if ctx.turn_said is not False or ctx.conversation_id is None:
        return None
    told = _told.get(ctx.conversation_id, 0)
    if told >= _MAX_SAY_FIRST:
        return None
    _told[ctx.conversation_id] = told + 1
    return json.dumps(SAY_FIRST)


def turn_ended(conversation_id: str) -> None:
    """Forget the turn's ``say_first`` count (``Feature.on_turn_end``)."""
    _told.pop(conversation_id, None)


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
