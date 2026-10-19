"""Runner side of tasks: the turn's task lines, the events the engine reports, the stall count.

* :func:`message_prefix` reads the Conversation's active tasks and writes one line each in front
  of the person's message, after "They picked ..." when the message answers a card. It opens the
  turn's :class:`~omnigent.superchat.tasks.record.Turn`, watched for a stall only when
  :func:`~omnigent.superchat.tasks.record.watched` says so. When the read says a finished Helper
  has a task to settle (``settle``), it reports the turn's start (``turn_start``): the server
  settles the task then, never on a read.
* :func:`on_result` reports what a tool did (``deck_new``, ``artifact_save``, ``start_helper``)
  to the server, in order per session, and notes it on the turn. It also reports a ``plan`` card
  and the results that are evidence for a plan step (ADR 0027: a brief, a read, a check), once
  a deliverable event of the turn names its task (:func:`_plan_evidence`).
* :func:`tool_denied` notes a step-limit refusal (:data:`STEP_LIMIT_REFUSAL`, the policy's own
  text) on the turn: the denied call never ran, so ``on_result`` never sees it.
* :func:`turn_ended` reports the end of a Conversation turn (the server settles finished Helpers,
  closes or reopens its tasks) and of a Helper turn that reported a task event (its finish: the
  server closes its task when no Conversation turn runs), and counts a **stall** by
  :func:`~omnigent.superchat.tasks.record.is_stall`. It only counts; it changes nothing. The
  decision of each task the server closed (at a turn's start or end) is journaled in the
  background (``decisions.journal_decision``).

Every server call here is metadata, bounded per ADR 0026: a 2 s budget (:data:`BUDGET`), one
retry for an event that timed out or whose connection dropped, never blocking the tool or the
turn. An event that still did not reach the server waits in :data:`_unsent`: the session's next
post sends it first, in order, and the turn's end posts (or flushes) last, so it is retried
within the turn. One still unsent then goes at the next turn in the background (never before
its own read), within the same budget, then is dropped with a WARNING. The server tolerates late
and out-of-order events.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

import httpx

from omnigent.entities.conversation import is_system_notice_text
from omnigent.superchat.step_limit.policy import REFUSAL as STEP_LIMIT_REFUSAL
from omnigent.superchat.tasks.decisions import journal_decision
from omnigent.superchat.tasks.record import (
    ACTIVE,
    BRIEF,
    EVIDENCE_KINDS,
    READ,
    CardAnswer,
    Task,
    Turn,
    evidence_for,
    is_stall,
    prefix_lines,
    replay,
    tick,
    watched,
)

if TYPE_CHECKING:
    from omnigent.superchat.feature import HandlerCtx

_logger = logging.getLogger(__name__)

SAVE, ASK, HELPER, DECK = "artifact_save", "ask_clarification", "start_helper", "deck_new"
#: The events a deliverable makes; the task one answers with is the task the turn's plan joins.
DELIVERABLES = frozenset({SAVE, HELPER, DECK})
#: The tools that end a turn on a task well: a deliverable, a question, a started Helper.
TURN_ENDINGS = frozenset({SAVE, ASK, HELPER})
#: The budget of one metadata call to the server (ADR 0026).
BUDGET = 2.0
_TIMEOUT = httpx.Timeout(BUDGET, connect=1.0)


@dataclass
class _Live:
    """A Conversation turn in flight.

    :param client: The server client its prefix read with (its ``turn_end`` goes there).
    :param task_id: The task it works on: the open task at its start, or the one its own events
        made (an ``ask`` card records it).
    :param turn: What it is and did, judged by :func:`is_stall` when it ends.
    :param reported: It reported a task event (so its end matters to the server).
    :param plans: The plan card ids it showed.
    :param early: Evidence a person's turn gathered before its first plan (sent with it).
    :param plan: Its plan as it stands here (a read is sent only when it ticks a step).
    :param delivered: The task its own deliverable event made or found: its plan joins that task
        (a plan with no deliverable joins none).
    :param waiting: Plan events held until the turn has :attr:`delivered`.
    """

    client: httpx.AsyncClient | None
    task_id: str | None
    turn: Turn
    reported: bool = False
    plans: set[str] = field(default_factory=set)
    early: list[dict[str, Any]] = field(default_factory=list)
    plan: dict[str, Any] | None = None
    delivered: str | None = None
    waiting: list[dict[str, Any]] = field(default_factory=list)


#: ``Conversation id -> the turn in flight``, for every Conversation turn.
_turns: dict[str, _Live] = {}
#: ``Conversation id -> its turn``, only for a turn whose ending (a save, a card, a Helper) can
#: make it a stall; a step-limit refusal is noted on every turn (``_Live.turn``).
_watching: dict[str, Turn] = {}
#: ``session id -> its server client``, for a turn that reported a task event outside a
#: Conversation turn (a Helper's): its end is reported too.
_loose: dict[str, httpx.AsyncClient] = {}
#: ``session id -> the last event post``, so a session's events reach the server in order.
_posts: dict[str, asyncio.Task[None]] = {}
#: ``session id -> events that did not reach the server``, oldest first, sent at the next turn.
_unsent: dict[str, list[dict[str, Any]]] = {}
#: The background sends of :data:`_unsent` (kept so they are not collected mid-flight).
_flushes: set[asyncio.Task[None]] = set()
#: Stalls counted since the process started.
STALLS = 0


async def read_tasks(client: httpx.AsyncClient | None, session_id: str | None) -> dict | None:
    """The server's task view of *session_id* (:meth:`TaskService.view`), or ``None``."""
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


def _task(raw: dict[str, Any], conversation_id: str) -> Task:
    return Task(
        id=raw["id"],
        owner="",
        conversation_id=conversation_id,
        kind=str(raw.get("kind") or "file"),
        title=str(raw.get("title") or ""),
        fields=raw.get("fields") if isinstance(raw.get("fields"), dict) else {},
        status=str(raw.get("status") or "open"),
        helper_ids=[str(h) for h in raw.get("helper_ids") or ()],
        helper_running=raw.get("helper_running") is True,
    )


def _tasks(view: dict[str, Any]) -> list[Task]:
    conversation_id = str(view.get("conversation_id") or "")
    return [
        _task(raw, conversation_id)
        for raw in view.get("tasks") or ()
        if isinstance(raw, dict) and isinstance(raw.get("id"), str)
    ]


#: The background journal writes (kept so they are not collected mid-flight).
_journals: set[asyncio.Task[None]] = set()


def _journal(conversation_id: str, closed: Any) -> None:
    """Journal the decisions of the tasks an event closed (the server put them in the working
    list), in the background; never blocks or fails the turn."""
    if not isinstance(closed, list):
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    for raw in closed:
        if isinstance(raw, dict):
            # A Helper's turn closes its Conversation's task: the journal is the Conversation's.
            at = raw.get("conversation_id")
            job = loop.create_task(journal_decision(at or conversation_id, raw))
            _journals.add(job)
            job.add_done_callback(_journals.discard)


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
    """The pick (when the message answers a card) and one line per active task, as one block.

    The tasks feature is Conversation-only (``Feature.conversation_only``): a Helper's turn never
    calls this. Events an earlier turn could not send go in the background.
    """
    _turns.pop(conversation_id, None)
    _watching.pop(conversation_id, None)
    if client is not None and _unsent:
        flush = asyncio.get_running_loop().create_task(flush_unsent(client))
        _flushes.add(flush)
        flush.add_done_callback(_flushes.discard)
    view = await read_tasks(client, conversation_id)
    if view is None or view.get("conversation_id") != conversation_id:
        return []
    tasks = _tasks(view)
    first = tasks[0] if tasks else None
    turn = Turn(
        by_person=view.get("by_person") is True
        and not any(is_system_notice_text(text) for text in texts),
        task_id=first.id if first else None,
        helper_running=first is not None and first.helper_running,
    )
    _turns[conversation_id] = _Live(client, first.id if first else None, turn)
    if watched(turn):
        _watching[conversation_id] = turn
    if client is not None and view.get("settle") is True:
        # A Helper of a task finished: the server settles it at the turn's start (a read never).
        _post(client, conversation_id, {"event": "turn_start"})
    comment = view.get("comment") if isinstance(view.get("comment"), dict) else None
    lines = prefix_lines(tasks, _answer(view), comment)
    return ["\n".join(lines)] if lines else []


def current_task(conversation_id: str | None) -> str | None:
    """The task the Conversation's running turn works on, or ``None``."""
    live = _turns.get(conversation_id or "")
    return live.task_id if live is not None else None


def _ok(output: str) -> dict[str, Any] | None:
    """A tool's JSON result when it succeeded, else ``None``."""
    try:
        data = json.loads(output)
    except ValueError:
        return None
    if not isinstance(data, dict) or "error" in data:
        return None
    return data


def _event(tool: str, data: dict[str, Any]) -> dict[str, Any] | None:
    """The task event a successful tool result reports, if any."""
    if tool == DECK and isinstance(data.get("deck"), dict):
        return {"event": DECK, **data["deck"], "written": data.get("written") is True}
    if tool == SAVE and data.get("type") == "artifact":
        return {
            "event": SAVE,
            "name": data.get("name"),
            "title": data.get("title"),
            "group_id": data.get("group_id") or data.get("id"),
            "artifact_id": data.get("id"),
        }
    if tool == HELPER and data.get("started") is True:
        return {"event": HELPER, "helper_id": data.get("helper_id"), "title": data.get("title")}
    return None


def _note_task(
    client: httpx.AsyncClient, session_id: str, body: dict[str, Any], resp: httpx.Response
) -> None:
    """The task an event made or changed becomes the running turn's task (a card names it); a
    deliverable's task is the one the turn's plan joins, and the plan events held for it go."""
    live = _turns.get(session_id)
    if live is None:
        return
    with contextlib.suppress(ValueError, AttributeError):
        task = resp.json().get("task")
        if not isinstance(task, dict) or not task.get("id"):
            return
        if task.get("status") in ACTIVE:
            live.task_id = str(task["id"])
        if body["event"] in DELIVERABLES and live.delivered is None:
            live.delivered = str(task["id"])
            for held in live.waiting:
                _post(client, session_id, {**held, "task_id": live.delivered})
            live.waiting = []


#: A connection that dropped under the post (a keep-alive the server closed during a long tool):
#: retried at once, like a timeout. A refused connection is not (the server is down).
_DROPPED = (httpx.RemoteProtocolError, httpx.ReadError, httpx.WriteError)


async def _send(
    client: httpx.AsyncClient, session_id: str, body: dict[str, Any], *, retry: bool
) -> str | None:
    """POST one event; why it did not reach the server, else ``None`` (a refusal counts as sent:
    the server answered)."""
    why = "not tried"
    for attempt in range(2 if retry else 1):
        try:
            resp = await asyncio.wait_for(
                client.post(
                    f"/v1/sessions/{session_id}/tasks/events", json=body, timeout=_TIMEOUT
                ),
                BUDGET,
            )
        except (httpx.TimeoutException, TimeoutError, *_DROPPED) as exc:
            why = (
                "timed out"
                if isinstance(exc, httpx.TimeoutException | TimeoutError)
                else f"connection dropped ({type(exc).__name__})"
            )
            _logger.info("task event %s %s (try %d)", body["event"], why, attempt + 1)
            continue
        except httpx.HTTPError as exc:
            return f"connection failed ({type(exc).__name__})"
        if resp.status_code >= 400:
            _logger.warning("task event %s refused: %s", body["event"], resp.status_code)
        else:
            _note_task(client, session_id, body, resp)
            if body["event"] in ("turn_start", "turn_end"):
                with contextlib.suppress(ValueError, AttributeError):
                    _journal(session_id, resp.json().get("closed"))
        return None
    return why


def _post(client: httpx.AsyncClient, session_id: str, body: dict[str, Any] | None) -> None:
    """Send this session's unsent events, then *body* (``None``: only those), after its earlier
    events (``on_result`` cannot await).

    The wait for the earlier send is bounded, so a stuck one never holds the rest back; an event
    that does not reach the server is queued for the session's next post or the next turn.
    """
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    before = _posts.get(session_id)

    async def send() -> None:
        if before is not None:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(asyncio.shield(before), BUDGET)
        for queued in [*_unsent.pop(session_id, ()), *([body] if body else ())]:
            why = await _send(client, session_id, queued, retry=queued is body)
            if why is not None:
                _unsent.setdefault(session_id, []).append(queued)
                _logger.warning(
                    "task event %s not sent (%s); kept for the next turn",
                    queued["event"],
                    why,
                    extra={"session_id": session_id},
                )

    task = loop.create_task(send())
    _posts[session_id] = task
    task.add_done_callback(
        lambda t: _posts.pop(session_id, None) if _posts.get(session_id) is t else None
    )


async def flush_unsent(client: httpx.AsyncClient) -> None:
    """Send the events earlier turns could not, within :data:`BUDGET` in all; drop the rest."""
    if not _unsent:
        return
    queued = [(session_id, body) for session_id, bodies in _unsent.items() for body in bodies]
    _unsent.clear()
    deadline = asyncio.get_running_loop().time() + BUDGET
    for session_id, body in queued:
        left = deadline - asyncio.get_running_loop().time()
        sent = False
        if left > 0:
            with contextlib.suppress(TimeoutError):
                why = await asyncio.wait_for(_send(client, session_id, body, retry=False), left)
                sent = why is None
        if not sent:
            _logger.warning(
                "task event %s dropped: the server did not take it",
                body["event"],
                extra={"session_id": session_id},
            )


def _plan_evidence(ctx: HandlerCtx, live: _Live | None, output: str) -> None:
    """Report a ``plan`` card, or a result that is evidence for a plan step (ADR 0027).

    A person's turn keeps the evidence it gathers before its first plan and sends it with that
    plan, so a brief read first ticks the plan's brief step and never an older plan's. A turn's
    plan events wait until a deliverable event of the turn names its task. A read (``brief``,
    ``read``) is sent only when it ticks a step of the turn's plan; a check always is (a
    Helper's check ticks the plan of the task it works for).
    """
    session_id = ctx.conversation_id or ""
    event = evidence_for(ctx.tool_name, output)
    if event is None or ctx.server_client is None:
        return
    if event["kind"] == "plan":
        if live is None:
            return
        body = {**event, "event": "plan"}
        del body["kind"]
        if event["id"] not in live.plans:
            live.plans.add(event["id"])
            body["evidence"], live.early = live.early, []
            live.plan = replay([*body["evidence"], event])
        else:
            live.plan = tick(live.plan, event)
        _send_plan(ctx.server_client, session_id, live, body)
        return
    if event["kind"] == "helper_started":
        if live is not None:
            _started(live, event)
        return
    if event["kind"] not in EVIDENCE_KINDS:
        return
    if event["kind"] in (BRIEF, READ):
        if live is None:
            return
        if live.plan is None:
            if live.turn.by_person:
                live.early.append(event)
            return
        ticked = tick(live.plan, event)
        if ticked == live.plan:
            return
        live.plan = ticked
        _send_plan(ctx.server_client, session_id, live, {"event": "evidence", **event})
        return
    task_id = live.delivered or live.task_id if live is not None else None
    if live is None:
        _loose[session_id] = ctx.server_client
    _post(ctx.server_client, session_id, {"event": "evidence", **event, "task_id": task_id})


def _started(live: _Live, event: dict[str, Any]) -> None:
    """A Helper the turn started takes its plan's Helper step.

    Before the plan, or while the plan waits for its deliverable (this start's own reply
    releases it), the start goes with the plan as its evidence, after the brief and reads the
    turn gathered first; a plan the server already has is ticked by the ``start_helper`` event.
    """
    if live.plan is None:
        live.early.append(event)
        return
    fresh = next((b for b in live.waiting if b["event"] == "plan" and "evidence" in b), None)
    if fresh is not None:
        fresh["evidence"] = [*fresh["evidence"], event]
        live.plan = tick(live.plan, event)


def _send_plan(
    client: httpx.AsyncClient, session_id: str, live: _Live, body: dict[str, Any]
) -> None:
    """Send a plan event once the turn's deliverable named its task; hold it until then."""
    live.reported = True
    if live.delivered is None:
        live.waiting.append(body)
        return
    _post(client, session_id, {**body, "task_id": live.delivered})


def on_result(ctx: HandlerCtx, output: str) -> None:
    """A feature tool ran: report its task event and note it on the watched turn."""
    session_id = ctx.conversation_id
    if not session_id:
        return
    live = _turns.get(session_id)
    tool = ctx.tool_name
    _plan_evidence(ctx, live, output)
    data = _ok(output) if tool in (DECK, *TURN_ENDINGS) else None
    if data is None:
        return
    event = _event(tool, data)
    turn = live.turn if live is not None else None
    if turn is not None:
        if tool == ASK:
            turn.asked = True
        elif tool == SAVE and event is not None:
            turn.saved = True
        elif tool == HELPER and event is not None:
            turn.helper_started = True
    if event is not None and ctx.server_client is not None:
        if live is not None:
            live.reported = True
        else:
            _loose[session_id] = ctx.server_client
        _post(ctx.server_client, session_id, event)


def tool_denied(ctx: HandlerCtx, _tool_name: str, reason: str) -> None:
    """A TOOL_CALL policy denied a call (``Feature.on_tool_denied``): a step-limit refusal is
    noted on the Conversation's turn, so ending it without a Helper is a stall."""
    live = _turns.get(ctx.conversation_id or "")
    if live is not None and STEP_LIMIT_REFUSAL in reason:
        live.turn.refused = True


def turn_ended(conversation_id: str) -> None:
    """A turn ended (``Feature.on_turn_end``): report a Conversation turn's end, or a Helper
    turn's that reported a task event, and count it when it is a stall."""
    global STALLS
    live = _turns.pop(conversation_id, None)
    _watching.pop(conversation_id, None)
    loose = _loose.pop(conversation_id, None)
    if live is None:
        if loose is not None:
            _post(loose, conversation_id, {"event": "turn_end"})
        return
    if live.client is not None and (live.task_id or live.reported):
        _post(live.client, conversation_id, {"event": "turn_end"})
    else:
        _logger.info(
            "turn_end of %s not sent: %s",
            conversation_id,
            "no server client" if live.client is None else "no task",
            extra={"session_id": conversation_id},
        )
        if live.client is not None and _unsent.get(conversation_id):
            _post(live.client, conversation_id, None)  # its unsent events, within the turn
    turn = live.turn
    if not is_stall(turn):
        return
    STALLS += 1
    _logger.info(
        "stall for %s on task %s",
        conversation_id,
        turn.task_id,
        extra={"session_id": conversation_id},
    )
