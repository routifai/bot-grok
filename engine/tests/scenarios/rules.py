"""When a turn ends well (ADR 0025): pure functions for the offline harness and the live runner.

A turn is a list of events, ``(kind, detail)`` pairs. The first event opens the turn:

- ``request``: the person asks for a deliverable (a deck, page, document, sheet or file);
- ``answer``: the person answers a question card, which continues a deliverable;
- ``message``: anything else the person says (a question, a lookup, chat);
- ``steer``: a message about work already running;
- ``notice``: a Helper's progress, flag or result waking the conversation.

What follows is what the assistant did: ``tool_call`` (detail: the tool name), ``plan`` (a plan
card), ``card`` (a question card; detail: what it asks about), ``helper_started``,
``message_helper``, ``save``, ``reply`` (detail: the text), and two the engine adds: ``refused``
(the step limit refused a call; detail: the tool name) and ``cancelled`` (the person stopped
the turn).
"""

from __future__ import annotations

from collections.abc import Sequence

Event = tuple[str, str]

#: The three ways a turn on a deliverable may end.
ENDINGS = frozenset({"save", "card", "helper_started"})
#: Openers that make a turn a turn on a deliverable.
DELIVERABLE_OPENERS = frozenset({"request", "answer"})
#: Words that hand the work back to the person instead of doing it.
GIVING_UP = (
    "send a message to continue",
    "send me a short message",
    "stop here for now",
    "stopped here for now",
)


def gives_up(text: str) -> bool:
    """Whether a reply tells the person to nudge the assistant instead of the work going on."""
    lowered = text.lower()
    return any(phrase in lowered for phrase in GIVING_UP)


def is_deliverable_turn(turn_events: Sequence[Event]) -> bool:
    """Whether the turn was opened by a request for a deliverable or an answer to its card."""
    return bool(turn_events) and turn_events[0][0] in DELIVERABLE_OPENERS


def ends_well(turn_events: Sequence[Event]) -> bool:
    """Whether a turn ends as ADR 0025 says a turn ends; ``False`` is a stall.

    A cancelled turn always ends well. No turn gives up in words. A turn the step limit refused
    must start a Helper after the refusal. A turn on a deliverable ends with a save, a question
    card or a started Helper.
    """
    kinds = [kind for kind, _ in turn_events]
    if "cancelled" in kinds:
        return True
    if any(kind == "reply" and gives_up(detail) for kind, detail in turn_events):
        return False
    if "refused" in kinds:
        last = len(kinds) - 1 - kinds[::-1].index("refused")
        if "helper_started" not in kinds[last + 1 :]:
            return False
    if not is_deliverable_turn(turn_events):
        return True
    return any(kind in ENDINGS for kind in kinds)


def asks(turns: Sequence[Sequence[Event]]) -> list[str]:
    """What each question card in a conversation asked about, in order."""
    return [detail for turn in turns for kind, detail in turn if kind == "card"]
