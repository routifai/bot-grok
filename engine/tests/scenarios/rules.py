"""When a turn ends well (ADR 0025) and speaks first (ADR 0026).

Pure functions for the offline harness and the live runner. Whether a turn ends well is the
engine's own rule (:func:`omnigent.superchat.tasks.record.ends_well`); this module only reads a
scripted turn as the engine's :class:`~omnigent.superchat.tasks.record.Turn`.

A turn is a list of events, ``(kind, detail)`` pairs. The first event opens the turn:

- ``request``: the person asks for a deliverable (a deck, page, document, sheet or file); no task
  is open yet, the turn's own work opens one;
- ``answer``: the person answers a question card, which continues an open task;
- ``message``: anything else the person says (a question, a lookup, chat);
- ``steer``: a message about work a Helper of the open task is running;
- ``notice``: a Helper's progress, flag or result waking the conversation.

What follows is what the assistant did: ``tool_call`` (detail: the tool name), ``plan`` (a plan
card), ``card`` (a question card; detail: what it asks about), ``helper_started``,
``message_helper``, ``save``, ``reply`` (detail: the text), and two the engine adds: ``refused``
(the step limit refused a call; detail: the tool name) and ``cancelled`` (the person stopped
the turn).
"""

from __future__ import annotations

from collections.abc import Sequence

from omnigent.superchat.tasks.record import Turn
from omnigent.superchat.tasks.record import ends_well as turn_ends_well

Event = tuple[str, str]

#: Openers a person sends (the rest are the runtime's notices).
PERSON_OPENERS = frozenset({"request", "answer", "message", "steer"})
#: Openers that find a task already open.
ON_A_TASK = frozenset({"answer", "steer"})
#: Openers that make a turn a turn on a deliverable.
DELIVERABLE_OPENERS = frozenset({"request", "answer"})
#: Assistant events that do work; a deliverable turn says something before the first of them.
WORK = frozenset({"tool_call", "helper_started", "save"})
#: Assistant events the person sees as the turn's first words.
SPOKEN = frozenset({"reply", "plan"})
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


def as_turn(turn_events: Sequence[Event]) -> Turn:
    """A scripted turn as the engine sees it."""
    opener = turn_events[0][0] if turn_events else ""
    kinds = {kind for kind, _ in turn_events[1:]}
    return Turn(
        by_person=opener in PERSON_OPENERS,
        task_id="task" if opener in ON_A_TASK else None,
        helper_running=opener == "steer",
        saved="save" in kinds,
        asked="card" in kinds,
        helper_started="helper_started" in kinds,
        refused="refused" in kinds,
    )


def ends_well(turn_events: Sequence[Event]) -> bool:
    """The engine's rule (:func:`omnigent.superchat.tasks.record.ends_well`) on a scripted turn;
    ``False`` is a stall."""
    return turn_ends_well(as_turn(turn_events))


def speaks_first(turn_events: Sequence[Event]) -> bool:
    """Whether a deliverable turn says something (a reply or a plan) before its first work call.

    A turn that is not on a deliverable, or that does no work (it ends on a question card), passes.
    """
    if not is_deliverable_turn(turn_events):
        return True
    for kind, _ in turn_events[1:]:
        if kind in SPOKEN:
            return True
        if kind in WORK:
            return False
    return True


def asks(turns: Sequence[Sequence[Event]]) -> list[str]:
    """What each question card in a conversation asked about, in order."""
    return [detail for turn in turns for kind, detail in turn if kind == "card"]
