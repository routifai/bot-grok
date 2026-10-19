"""Write a Round's events where the engine sees each fact (ADR 0029). Nothing here reads them.

* :func:`assign_round` is the one rule for which Round a stored message belongs to.
* :class:`Recorder` appends events in order on a background task: a write never blocks the
  turn or the request that saw the fact, and a failed write is logged, never raised. Streamed
  words are joined per :data:`WORDS_EVERY` seconds.
* :class:`RelayRound` turns one session's runner stream, as the server relays it, into events:
  turns, words, tool calls, a Helper's finish, chips and checklist changes.
* :func:`note_message`, :func:`helper_created`, :func:`file_saved` and
  :func:`stop_requested` are the writers at a stored message, a Helper's creation, an artifact
  save and Stop.

Only Superchat sessions are recorded; a session outside a Round records nothing.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import re
import time
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from omnigent.context.labels import (
    BACKGROUND_LABELS,
    ROUND_LABEL_KEY,
    is_artifact_chat,
    is_superside_chat,
)
from omnigent.context.tool_digest import short_arguments
from omnigent.runner.tool_starts import STOPPED_OUTPUT
from omnigent.superchat.rounds.fold import (
    ASSISTANT,
    CHECKLIST_CREATED,
    CHECKLIST_UPDATED,
    CHIPS,
    FILE_SAVED,
    HELPER,
    HELPER_FINISHED,
    HELPER_STARTED,
    PERSON,
    ROUND_OPENED,
    STOP_REQUESTED,
    SYSTEM,
    TOOL_CALLED,
    TOOL_INPUT,
    TOOL_RESULT,
    TOOL_STARTED,
    TURN_ENDED,
    TURN_STARTED,
    WAKE,
    WORDS,
)
from omnigent.superchat.rounds.store import RoundEvent, SqlAlchemyRoundStore
from omnigent.superchat.titles import clip

_logger = logging.getLogger(__name__)

#: Seconds of streamed words joined into one ``words`` event.
WORDS_EVERY = 0.25
#: Seconds between two ``tool.input`` events of one call.
INPUT_EVERY = 1.0
#: Longest Helper result kept on ``helper.finished``.
RESULT_LIMIT = 500
#: The stream event a harness sends as a tool call's arguments stream (see the executor adapter).
TOOL_INPUT_DELTA = "response.function_call_arguments.delta"
#: A turn's terminal stream events and the status each gives a Helper that ends with it.
_TERMINAL = {
    "response.completed": "done",
    "response.failed": "failed",
    "response.incomplete": "failed",
    "response.cancelled": "stopped",
}
#: Native checklist tools (Claude's task tools; the pi ``checklist`` tool reuses the shape).
_CHECKLIST_CREATE, _CHECKLIST_UPDATE = "TaskCreate", "TaskUpdate"
_TASK_NUMBER = re.compile(r"#(\d+)")
#: The tool whose arguments are the follow-up chips.
_CHIPS_TOOL = "suggest_follow_ups"


@dataclass(frozen=True)
class Assignment:
    """The Round a stored message belongs to.

    :param round_id: The Round.
    :param opened: The message opens it (a ``round.opened`` follows).
    :param actor: Who opened it: ``person``, or ``system`` for a hidden Round.
    """

    round_id: str
    opened: bool = False
    actor: str = PERSON


def assign_round(
    *,
    item_id: str,
    labels: Mapping[str, str] | None,
    helper: bool,
    by_person: bool,
    turn_running: bool,
    helper_round: str | None = None,
) -> Assignment | None:
    """The Round a message joins, decided once, when the message is stored.

    The rule is ADR 0029's: "A Round is one message from the person through its settlement. A
    steer joins the running turn's Round. A wake, notice or timer turn carries the Round of the
    Helper that caused it. Scheduled and system runs get a hidden Round of their own." Here:

    1. Outside a Superchat session there is no Round.
    2. A run no person started (its session carries a background label) and that has no Round
       yet opens a hidden one: actor ``system``, id the message's own.
    3. A Helper's messages (its brief, a send to it) join the Round it was created in.
    4. A notice that is not the person's words (a Helper's wake or progress, a timer) joins the
       Round of the Helper that sent it, else the session's current Round.
    5. The person's message while a turn runs is a steer: it joins the current Round.
    6. Any other message from the person opens a new Round whose id is the message's id.

    :param item_id: The stored message's id.
    :param labels: The session's labels; :data:`ROUND_LABEL_KEY` is its current Round.
    :param helper: The session is a Helper.
    :param by_person: The message is the person's words, not a notice.
    :param turn_running: A turn of the session runs as the message is stored.
    :param helper_round: The Round of the Helper a notice came from, when it names one.
    :returns: The Round, or ``None`` when the message is in none.
    """
    if not is_superside_chat(labels):
        return None
    current = (labels or {}).get(ROUND_LABEL_KEY) or None
    if current is None and any(key in (labels or {}) for key in BACKGROUND_LABELS):
        return Assignment(item_id, opened=True, actor=SYSTEM)
    if helper:
        return Assignment(current) if current else None
    if not by_person:
        joined = helper_round or current
        return Assignment(joined) if joined else None
    if turn_running and current:
        return Assignment(current)
    return Assignment(item_id, opened=True)


class Recorder:
    """Appends Round events in order on one background task; never blocks, never raises."""

    def __init__(self, store: SqlAlchemyRoundStore) -> None:
        self._store = store
        self._queue: list[RoundEvent] = []
        self._drain: asyncio.Task[None] | None = None
        #: ``(round, actor, helper) -> [first chunk ms, conversation, chunks]`` not yet queued.
        self._words: dict[tuple[str, str, str | None], list[Any]] = {}

    def record(
        self, round_id: str, conversation_id: str, kind: str, actor: str, **body: Any
    ) -> None:
        """Queue one event of *round_id*, after any words of that Round still being joined."""
        self._flush_words(round_id)
        self._queue_event(
            RoundEvent(round_id, conversation_id, kind, actor, _now_ms(), _clean(body))
        )

    def words(
        self,
        round_id: str,
        conversation_id: str,
        actor: str,
        text: str,
        helper_id: str | None = None,
    ) -> None:
        """Join a streamed chunk into the actor's ``words`` event, queued every
        :data:`WORDS_EVERY` seconds or before the Round's next event."""
        key = (round_id, actor, helper_id)
        pending = self._words.setdefault(key, [_now_ms(), conversation_id, []])
        pending[2].append(text)
        if _now_ms() - pending[0] >= WORDS_EVERY * 1000:
            self._flush_words(round_id)

    def _flush_words(self, round_id: str) -> None:
        for key in [k for k in self._words if k[0] == round_id]:
            at_ms, conversation_id, chunks = self._words.pop(key)
            body = _clean({"text": "".join(chunks), "helper_id": key[2]})
            self._queue_event(RoundEvent(round_id, conversation_id, WORDS, key[1], at_ms, body))

    def _queue_event(self, event: RoundEvent) -> None:
        log = _logger.debug if event.kind in (WORDS, TOOL_INPUT) else _logger.info
        log("round %s %s %s %s", event.round_id, event.kind, event.actor, event.body)
        self._queue.append(event)
        if self._drain is None or self._drain.done():
            try:
                self._drain = asyncio.get_running_loop().create_task(self._write())
            except RuntimeError:  # no loop: nothing in the engine records from a bare thread
                _logger.warning("round events dropped: no running loop")
                self._queue.clear()

    async def _write(self) -> None:
        while self._queue:
            batch, self._queue = self._queue, []
            try:
                await asyncio.to_thread(self._store.append, batch)
            except Exception:
                _logger.warning("round events not stored (%d dropped)", len(batch), exc_info=True)

    async def idle(self) -> None:
        """Wait until every queued event is written (for tests and shutdown)."""
        for round_id in {k[0] for k in self._words}:
            self._flush_words(round_id)
        while self._drain is not None and not self._drain.done():
            await asyncio.shield(self._drain)


#: The engine's recorder, set when the rounds feature is installed; ``None`` records nothing.
RECORDER: Recorder | None = None


def _now_ms() -> int:
    return int(time.time() * 1000)


def _clean(body: Mapping[str, Any]) -> dict[str, Any]:
    """*body* without its empty fields."""
    return {k: v for k, v in body.items() if v is not None}


def _record(round_id: str, conversation_id: str, kind: str, actor: str, **body: Any) -> None:
    if RECORDER is not None:
        RECORDER.record(round_id, conversation_id, kind, actor, **body)


def _is_helper(conversation: Any) -> bool:
    """Whether a session acts as a Helper in its Round. A run no person started is the main
    actor of its own hidden Round, even when it is a child session."""
    labels = conversation.labels or {}
    return conversation.kind == "sub_agent" and not any(k in labels for k in BACKGROUND_LABELS)


def _round_of(labels: Mapping[str, str] | None) -> str | None:
    """The Round a session's labels say it is in, for a Superchat session."""
    if not is_superside_chat(labels):
        return None
    return (labels or {}).get(ROUND_LABEL_KEY) or None


def _text(data: Mapping[str, Any]) -> str:
    parts = data.get("content")
    return (
        "".join(str(p.get("text") or "") for p in parts if isinstance(p, Mapping))
        if isinstance(parts, list)
        else ""
    )


async def note_message(
    conversation_store: Any,
    conversation: Any,
    item_id: str,
    data: Mapping[str, Any],
    context: Mapping[str, Any] | None,
    *,
    turn_running: bool,
) -> None:
    """Give a stored message its Round (:func:`assign_round`) and record what it starts.

    A person's message that opens a Round records ``round.opened``; a Helper's notice records
    ``wake``. When the Round is not the session's current one, the session's
    :data:`ROUND_LABEL_KEY` moves to it before the turn starts. Never raises.

    :param conversation: The session's row.
    :param item_id: The stored message's id.
    :param data: The message's data (``role``, ``content``, ``is_system_notice``).
    :param context: The message's ``context``; a Helper's notice names ``helper_id``.
    :param turn_running: A turn of the session runs as it is stored.
    """
    try:
        labels = conversation.labels
        if not is_superside_chat(labels):
            return
        by_person = data.get("role", "user") == "user" and data.get("is_system_notice") is not True
        named = (context or {}).get("helper_id")
        helper_id = helper_round = None
        if not by_person and isinstance(named, str) and named:
            helper = await asyncio.to_thread(conversation_store.get_conversation, named)
            if helper is not None and helper.parent_conversation_id == conversation.id:
                helper_id, helper_round = named, _round_of(helper.labels)
        assigned = assign_round(
            item_id=item_id,
            labels=labels,
            helper=conversation.kind == "sub_agent",
            by_person=by_person,
            turn_running=turn_running,
            helper_round=helper_round,
        )
        if assigned is None:
            return
        if assigned.round_id != labels.get(ROUND_LABEL_KEY):
            await asyncio.to_thread(
                conversation_store.set_labels,
                conversation.id,
                {ROUND_LABEL_KEY: assigned.round_id},
            )
        root = conversation.root_conversation_id or conversation.id
        if assigned.opened:
            text = _text(data)
            _record(
                assigned.round_id, root, ROUND_OPENED, assigned.actor, text=text, item_id=item_id
            )
        elif helper_id is not None:
            _record(assigned.round_id, root, WAKE, SYSTEM, helper_id=helper_id, item_id=item_id)
    except Exception:
        _logger.warning("message %s not given a Round", item_id, exc_info=True)


def helper_labels(
    parent_labels: Mapping[str, str] | None, child_labels: Mapping[str, str]
) -> dict[str, str]:
    """The Round label a child session gets at creation: a Helper belongs to the Round its
    parent is in. A file's studio and a run no person started (a scheduled Helper) get none.
    """
    round_id = _round_of(parent_labels)
    if round_id is None or is_artifact_chat(child_labels):
        return {}
    if any(key in child_labels for key in BACKGROUND_LABELS):
        return {}
    return {ROUND_LABEL_KEY: round_id}


def helper_created(conversation: Any) -> None:
    """Record ``helper.started`` for a Helper session just created in a Round."""
    round_id = _round_of(conversation.labels)
    if round_id is None or conversation.parent_conversation_id is None:
        return
    _record(
        round_id,
        conversation.root_conversation_id or conversation.id,
        HELPER_STARTED,
        ASSISTANT,
        helper_id=conversation.id,
        title=conversation.title,
        folder=conversation.workspace,
    )


def file_saved(saver: Any, artifact: Any) -> None:
    """Record ``file.saved`` for an artifact version saved by a session in a Round."""
    round_id = _round_of(saver.labels)
    if round_id is None:
        return
    helper = _is_helper(saver)
    _record(
        round_id,
        saver.root_conversation_id or saver.id,
        FILE_SAVED,
        HELPER if helper else ASSISTANT,
        name=artifact.name,
        file_kind=artifact.kind,
        artifact_id=artifact.id,
        version=artifact.version,
        helper_id=saver.id if helper else None,
    )


def stop_requested(conversation: Any) -> None:
    """Record ``stop.requested`` when the person stops the Conversation's Round."""
    round_id = _round_of(conversation.labels)
    if round_id is None or conversation.kind == "sub_agent":
        return
    _record(round_id, conversation.id, STOP_REQUESTED, PERSON, scope="round")


def _args(raw: Any) -> dict[str, Any]:
    if isinstance(raw, str):
        with contextlib.suppress(ValueError):
            raw = json.loads(raw)
    return raw if isinstance(raw, dict) else {}


def _ok(output: Any) -> bool:
    """Whether a tool's output reads as success: not the stopped marker, not ``{"error"}``."""
    if output == STOPPED_OUTPUT:
        return False
    parsed = _args(output)
    return not parsed.get("error")


@dataclass
class _Turn:
    round_id: str
    conversation_id: str
    actor: str
    helper_id: str | None
    text: list[str] = field(default_factory=list)


class RelayRound:
    """One session's runner stream, recorded as the events of the Round its turns are in.

    The server's relay hands it every frame (:meth:`observe`); a turn's Round is read from the
    session's label when the turn starts.
    """

    def __init__(self, session_id: str, conversation_store: Any) -> None:
        self._session_id = session_id
        self._store = conversation_store
        self._turn: _Turn | None = None
        #: ``False`` once the session reads as outside Superchat: its turns are never read again.
        self._superside: bool | None = None
        self._calls: dict[str, tuple[str, dict[str, Any]]] = {}
        self._called: set[str] = set()
        self._inputs: dict[str, list[float]] = {}

    async def observe(self, event: Mapping[str, Any]) -> None:
        """Record what *event* says happened, if this session's turn is in a Round."""
        if RECORDER is None:
            return
        kind = event.get("type")
        try:
            if kind == "response.in_progress":
                await self._begin()
            turn = self._turn
            if turn is None:
                return
            if kind == "response.output_text.delta" and isinstance(event.get("delta"), str):
                turn.text.append(event["delta"])
                RECORDER.words(
                    turn.round_id, turn.conversation_id, turn.actor, event["delta"], turn.helper_id
                )
            elif kind == TOOL_INPUT_DELTA:
                self._input(turn, event)
            elif kind == "response.output_item.done" and isinstance(event.get("item"), Mapping):
                self._item(turn, event["item"])
            elif kind in _TERMINAL:
                self._end(turn, _TERMINAL[str(kind)])
        except Exception:
            _logger.warning("round event not recorded for %s", self._session_id, exc_info=True)

    async def _begin(self) -> None:
        self._turn = None
        if self._superside is False:
            return
        conv = await asyncio.to_thread(self._store.get_conversation, self._session_id)
        if conv is not None:
            self._superside = is_superside_chat(conv.labels)
        round_id = _round_of(conv.labels) if conv is not None else None
        if conv is None or round_id is None:
            self._turn = None
            return
        helper = _is_helper(conv)
        self._turn = _Turn(
            round_id,
            conv.root_conversation_id or conv.id,
            HELPER if helper else ASSISTANT,
            conv.id if helper else None,
        )
        self._calls, self._called, self._inputs = {}, set(), {}
        self._emit(self._turn, TURN_STARTED)

    def _emit(self, turn: _Turn, kind: str, **body: Any) -> None:
        if RECORDER is not None:
            RECORDER.record(
                turn.round_id,
                turn.conversation_id,
                kind,
                turn.actor,
                helper_id=turn.helper_id,
                **body,
            )

    def _started(self, turn: _Turn, call_id: str, name: str) -> None:
        if call_id not in self._calls:
            self._calls[call_id] = (name, {})
            self._emit(turn, TOOL_STARTED, call_id=call_id, name=name)

    def _input(self, turn: _Turn, event: Mapping[str, Any]) -> None:
        call_id, name = str(event.get("call_id") or ""), str(event.get("name") or "")
        if not call_id:
            return
        self._started(turn, call_id, name)
        size = self._inputs.setdefault(call_id, [0.0, 0.0])
        size[0] += len(str(event.get("delta") or "").encode())
        now = time.monotonic()
        if size[0] and now - size[1] >= INPUT_EVERY:
            size[1] = now
            self._emit(turn, TOOL_INPUT, call_id=call_id, name=name, bytes=int(size[0]))

    def _item(self, turn: _Turn, item: Mapping[str, Any]) -> None:
        call_id = item.get("call_id")
        if not isinstance(call_id, str) or not call_id:
            return
        if item.get("type") == "function_call":
            name = str(item.get("name") or "")
            self._started(turn, call_id, name)
            if call_id not in self._called:
                self._called.add(call_id)
                args = _args(item.get("arguments"))
                self._calls[call_id] = (name, args)
                self._emit(
                    turn, TOOL_CALLED, call_id=call_id, name=name, digest=short_arguments(args)
                )
            turn.text.clear()  # the words before a call are not the turn's last text
        elif item.get("type") == "function_call_output":
            name, args = self._calls.get(call_id, ("", {}))
            output = item.get("output")
            ok = _ok(output)
            self._emit(turn, TOOL_RESULT, call_id=call_id, name=name, ok=ok)
            if ok:
                self._effect(turn, name, args, output)

    def _effect(self, turn: _Turn, name: str, args: Mapping[str, Any], output: Any) -> None:
        """The chips and checklist a tool call that worked made."""
        if name == _CHIPS_TOOL and turn.actor == ASSISTANT:
            items = args.get("items")
            if isinstance(items, list):
                self._emit(turn, CHIPS, items=[str(i) for i in items])
        elif name == _CHECKLIST_CREATE:
            number = _TASK_NUMBER.search(str(output or ""))
            self._emit(
                turn,
                CHECKLIST_CREATED,
                item_id=number.group(1) if number else None,
                subject=args.get("subject"),
                active_form=args.get("activeForm"),
            )
        elif name == _CHECKLIST_UPDATE:
            self._emit(
                turn,
                CHECKLIST_UPDATED,
                item_id=str(args.get("taskId") or "") or None,
                status=args.get("status"),
                subject=args.get("subject"),
                active_form=args.get("activeForm"),
            )

    def _end(self, turn: _Turn, status: str) -> None:
        self._emit(turn, TURN_ENDED, status=status)
        if turn.actor == HELPER:
            result = clip("".join(turn.text).strip(), RESULT_LIMIT)
            self._emit(turn, HELPER_FINISHED, status=status, result=result)
        self._turn = None
