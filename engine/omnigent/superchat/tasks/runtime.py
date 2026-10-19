"""Runner side of tasks: the turn's lines and the stall count.

* :func:`message_prefix` reads the server's view and writes, in front of the person's message,
  "They picked ..." when the message answers a card, then one line per Round still working
  (:func:`~omnigent.superchat.tasks.record.round_line`). It opens the turn's
  :class:`~omnigent.superchat.tasks.record.Turn` and keeps the turn's Round, which an ``ask``
  card names (:func:`current_round`).
* :func:`on_result` notes what a tool did on the turn. No tool result is reported: the Round
  record has every tool's result from the relay.
* :func:`tool_denied` notes a step-limit refusal (:data:`STEP_LIMIT_REFUSAL`, the policy's own
  text) on the turn: the denied call never ran, so ``on_result`` never sees it.
* :func:`turn_ended` counts a **stall** by :func:`~omnigent.superchat.tasks.record.is_stall`. It
  only counts; it changes nothing.

The read is metadata, bounded per ADR 0026: a 2 s budget (:data:`BUDGET`), never blocking the
turn.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

import httpx

from omnigent.entities.conversation import is_system_notice_text
from omnigent.superchat.step_limit.policy import REFUSAL as STEP_LIMIT_REFUSAL
from omnigent.superchat.tasks.record import CardAnswer, Turn, is_stall, prefix_lines

if TYPE_CHECKING:
    from omnigent.superchat.feature import HandlerCtx

_logger = logging.getLogger(__name__)

SAVE, ASK, HELPER = "artifact_save", "ask_clarification", "start_helper"
#: The tools that end a turn on a deliverable well: a save, a question, a started Helper.
TURN_ENDINGS = frozenset({SAVE, ASK, HELPER})
#: The budget of the read from the server (ADR 0026).
BUDGET = 2.0
_TIMEOUT = httpx.Timeout(BUDGET, connect=1.0)


@dataclass
class _Live:
    """A Conversation turn in flight.

    :param round_id: The Round it is in (an ``ask`` card names it).
    :param turn: What it is and did, judged by :func:`is_stall` when it ends.
    """

    round_id: str | None
    turn: Turn


#: ``Conversation id -> the turn in flight``, for every Conversation turn.
_turns: dict[str, _Live] = {}
#: Stalls counted since the process started.
STALLS = 0


async def read_tasks(client: httpx.AsyncClient | None, session_id: str | None) -> dict | None:
    """The server's view of *session_id* (:meth:`TaskService.view`), or ``None``."""
    if client is None or not session_id:
        return None
    try:
        resp = await asyncio.wait_for(
            client.get(f"/v1/sessions/{session_id}/tasks", timeout=_TIMEOUT), BUDGET
        )
        view = resp.json() if resp.status_code == 200 else None
    except (httpx.HTTPError, ValueError, TimeoutError):
        _logger.info("tasks of %s not read in time", session_id, extra={"session_id": session_id})
        return None
    return view if isinstance(view, dict) else None


def _answer(view: dict[str, Any]) -> CardAnswer | None:
    raw = view.get("answer")
    if not isinstance(raw, dict):
        return None
    try:
        return CardAnswer(str(raw["card_id"]), str(raw["option_id"]), str(raw["label"]))
    except KeyError:
        return None


async def message_prefix(
    client: httpx.AsyncClient | None, conversation_id: str, texts: Sequence[str]
) -> list[str]:
    """The pick (when the person's message answers a card) and one line per Round still working,
    as one block.

    The tasks feature is Conversation-only (``Feature.conversation_only``): a Helper's turn never
    calls this.
    """
    _turns.pop(conversation_id, None)
    view = await read_tasks(client, conversation_id)
    if view is None or view.get("conversation_id") != conversation_id:
        return []
    rounds = [r for r in view.get("rounds") or () if isinstance(r, dict)]
    by_person = view.get("by_person") is True and not any(
        is_system_notice_text(text) for text in texts
    )
    round_id = view.get("round_id") if isinstance(view.get("round_id"), str) else None
    turn = Turn(by_person=by_person, helper_running=bool(rounds))
    _turns[conversation_id] = _Live(round_id, turn)
    lines = prefix_lines(rounds, _answer(view) if by_person else None)
    return ["\n".join(lines)] if lines else []


def current_round(conversation_id: str | None) -> str | None:
    """The Round the Conversation's running turn is in, or ``None``."""
    live = _turns.get(conversation_id or "")
    return live.round_id if live is not None else None


def _ok(output: str | None) -> bool:
    """Whether a tool's output reads as success: some output, and not a JSON ``{"error"}``."""
    if not output or not output.strip():
        return False
    try:
        data = json.loads(output)
    except ValueError:
        return True
    return not (isinstance(data, dict) and "error" in data)


def on_result(ctx: HandlerCtx, output: str) -> None:
    """A feature tool ran: note what it did on the Conversation's turn."""
    live = _turns.get(ctx.conversation_id or "")
    tool = ctx.tool_name
    if live is None or tool not in TURN_ENDINGS or not _ok(output):
        return
    if tool == ASK:
        live.turn.asked = True
    elif tool == SAVE:
        live.turn.saved = True
    else:
        live.turn.helper_started = True


def tool_denied(ctx: HandlerCtx, _tool_name: str, reason: str) -> None:
    """A TOOL_CALL policy denied a call (``Feature.on_tool_denied``): a step-limit refusal is
    noted on the Conversation's turn, so ending it without a Helper is a stall."""
    live = _turns.get(ctx.conversation_id or "")
    if live is not None and STEP_LIMIT_REFUSAL in reason:
        live.turn.refused = True


def turn_ended(conversation_id: str) -> None:
    """A turn ended (``Feature.on_turn_end``): count it when it is a stall."""
    global STALLS
    live = _turns.pop(conversation_id, None)
    if live is None or not is_stall(live.turn):
        return
    STALLS += 1
    _logger.info("stall for %s", conversation_id, extra={"session_id": conversation_id})
