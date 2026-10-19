"""Write a Round's events where the engine sees each fact (ADR 0029), and journal it once settled.

* :func:`assign_round` is the one rule for which Round a stored message belongs to.
* :class:`Recorder` appends events in order on a background task: a write never blocks the
  turn or the request that saw the fact, and a failed write is logged, never raised. Streamed
  words are joined per :data:`WORDS_EVERY` seconds. Each stored batch is handed to the
  recorder's ``on_written`` (:mod:`omnigent.superchat.rounds.read`).
* :class:`RelayRound` turns one session's runner stream, as the server relays it, into events:
  turns, words, tool calls, a Helper's finish, chips and checklist changes.
* :func:`note_message`, :func:`helper_created` and :func:`file_saved` are the writers at a
  stored message, a Helper's creation and an artifact save.
* :func:`stop_round` is Stop: it picks the Round the person stops, records ``stop.requested``
  and returns the Stop line; :func:`stopped_wake` tells a Helper's late notice of a stopped
  Round from one that may still start a turn.
* Settlement is detected where the settling events are written: after the :class:`Recorder`
  stored a ``turn.ended``, ``helper.finished`` or ``stop.requested``, it folds that Round and,
  the first time the fold says settled, hands :func:`journal_entry` of the view to its
  ``on_settled`` sink (the Round's one journal entry, written in the host).

Only Superchat sessions are recorded; a session outside a Round records nothing.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import re
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from omnigent.context.labels import (
    BACKGROUND_LABELS,
    ROUND_LABEL_KEY,
    is_artifact_chat,
    is_superside_chat,
)
from omnigent.context.tool_digest import short_arguments
from omnigent.entities.session_project import project_slug_from_workspace
from omnigent.runner.tool_starts import STOPPED_OUTPUT
from omnigent.superchat.artifact_kinds import is_deck_name
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
    fold,
)
from omnigent.superchat.rounds.store import RoundEvent, SqlAlchemyRoundStore
from omnigent.superchat.tasks.record import CHECK_TOOLS
from omnigent.superchat.titles import clip, one_line_summary

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
#: Events after which a Round may have settled; the fold decides.
_SETTLING = frozenset({TURN_ENDED, HELPER_FINISHED, STOP_REQUESTED})
#: Longest ask kept in a journal entry.
ASK_LIMIT = 120
#: Settled Rounds remembered, so a late event does not fold a settled Round again.
_SETTLED_KEPT = 4096
_IN_WORKSPACE = re.compile(r"(?:^|/)workspace/(.+)$")

#: ``(conversation id, journal entry) -> None``: where a settled Round's entry goes.
Settled = Callable[[str, dict[str, Any]], Awaitable[None]]


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


def checked(view: Mapping[str, Any]) -> bool | None:
    """Whether the Round's deck was checked: a ``deck_check`` in its trail, the Assistant's or a
    Helper's, came back clean; ``None`` for a Round that saved no deck and ran no check."""
    check = CHECK_TOOLS["deck"]
    checks = [t for t in view["trail"] if str(t.get("name") or "").rsplit("__", 1)[-1] == check]
    if not checks and not any(is_deck_name(str(f.get("name") or "")) for f in view["files"]):
        return None
    return any(t.get("ok") for t in checks)


def journal_entry(round_id: str, view: Mapping[str, Any]) -> dict[str, Any] | None:
    """The journal entry of a settled Round, built only from its view (:func:`fold`).

    :returns: ``round_id``, ``date`` (the settlement's, UTC), ``ask`` (the first line of the
        person's message, clipped), ``outcome`` (the first sentence of the last Assistant
        text), ``stopped``, ``files`` (names), ``helpers`` (titles), ``folder`` (the Helpers'
        folders), ``seconds``, ``checked`` (:func:`checked`) and ``refs``; ``None`` for a Round
        not settled or hidden (a run no person started writes no entry).
    """
    if view.get("settled_at") is None or view.get("hidden"):
        return None
    asked = [line.strip() for line in str(view.get("ask") or "").splitlines() if line.strip()]
    said = [w for w in view.get("words") or [] if w.strip()]
    helpers = list(view["helpers"].values())
    folders = list(dict.fromkeys(h["folder"] for h in helpers if h.get("folder")))
    shown = [m.group(1) if (m := _IN_WORKSPACE.search(f)) else f for f in folders]
    files = [f for f in view["files"] if f.get("name")]
    return {
        "round_id": round_id,
        "date": f"{datetime.fromtimestamp(view['settled_at'], UTC):%Y-%m-%d}",
        "ask": clip(asked[0], ASK_LIMIT) if asked else "",
        "outcome": (one_line_summary(said[-1]) or "") if said else "",
        "stopped": view["status"] == "stopped",
        "files": [f["name"] for f in files],
        "helpers": [h["title"] for h in helpers if h.get("title")],
        "folder": ", ".join(shown),
        "seconds": view["elapsed"],
        "checked": checked(view),
        "refs": {
            "artifacts": [
                f"{f['artifact_id']}@v{f['version']}"
                for f in files
                if f.get("artifact_id") and f.get("version")
            ],
            "project": list(
                dict.fromkeys(p for f in folders if (p := project_slug_from_workspace(f)))
            ),
            "helpers": [h["id"] for h in helpers],
        },
    }


class Recorder:
    """Appends Round events in order on one background task; never blocks, never raises."""

    def __init__(
        self,
        store: SqlAlchemyRoundStore,
        on_written: Callable[[Sequence[RoundEvent]], None] | None = None,
        on_settled: Settled | None = None,
    ) -> None:
        """
        :param on_written: Called on the loop with each batch once it is stored.
        :param on_settled: Given each settled Round's :func:`journal_entry`, once per Round in
            this process; the writer it reaches keeps it once across processes too.
        """
        self._store = store
        self._on_written = on_written
        self._queue: list[RoundEvent] = []
        self._drain: asyncio.Task[None] | None = None
        self._on_settled = on_settled
        self._settled: dict[str, None] = {}
        self._journals: set[asyncio.Task[None]] = set()
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
                continue
            if self._on_written is not None:
                try:
                    self._on_written(batch)
                except Exception:
                    _logger.warning("round events stored, not announced", exc_info=True)
            await self._settle(batch)

    async def view(self, round_id: str) -> dict[str, Any]:
        """The Round's view, folded from its stored events once every queued one is written."""
        await self.idle()
        events = await asyncio.to_thread(self._store.events, round_id)
        return fold(events, round_id)

    async def _settle(self, batch: list[RoundEvent]) -> None:
        """Fold each Round a settling event of *batch* is in; journal the newly settled ones."""
        if self._on_settled is None:
            return
        maybe = {
            e.round_id: e.conversation_id
            for e in batch
            if e.kind in _SETTLING and e.round_id not in self._settled
        }
        for round_id, conversation_id in maybe.items():
            try:
                view = fold(await asyncio.to_thread(self._store.events, round_id), round_id)
            except Exception:
                _logger.warning("round %s not folded", round_id, exc_info=True)
                continue
            if view["settled_at"] is None:
                continue
            self._settled[round_id] = None
            while len(self._settled) > _SETTLED_KEPT:
                del self._settled[next(iter(self._settled))]
            entry = journal_entry(round_id, view)
            if entry is not None:
                task = asyncio.get_running_loop().create_task(
                    _journal(self._on_settled, conversation_id, entry)
                )
                self._journals.add(task)
                task.add_done_callback(self._journals.discard)

    async def idle(self) -> None:
        """Wait until every queued event is written and every entry journaled (tests, shutdown)."""
        for round_id in {k[0] for k in self._words}:
            self._flush_words(round_id)
        while self._drain is not None and not self._drain.done():
            await asyncio.shield(self._drain)
        if self._journals:
            await asyncio.gather(*self._journals)


async def _journal(sink: Settled, conversation_id: str, entry: dict[str, Any]) -> None:
    try:
        await sink(conversation_id, entry)
    except Exception:
        _logger.warning("round %s not journaled", entry["round_id"], exc_info=True)


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


def round_of(labels: Mapping[str, str] | None) -> str | None:
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


def _by_person(data: Mapping[str, Any]) -> bool:
    return data.get("role", "user") == "user" and data.get("is_system_notice") is not True


async def _notice_helper(
    conversation_store: Any, conversation: Any, context: Mapping[str, Any] | None
) -> tuple[str | None, str | None]:
    """The Helper of *conversation* a notice names in its ``context``, and that Helper's Round."""
    named = (context or {}).get("helper_id")
    if not isinstance(named, str) or not named:
        return None, None
    helper = await asyncio.to_thread(conversation_store.get_conversation, named)
    if helper is None or helper.parent_conversation_id != conversation.id:
        return None, None
    return named, round_of(helper.labels)


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
        by_person = _by_person(data)
        helper_id, helper_round = (
            (None, None)
            if by_person
            else await _notice_helper(conversation_store, conversation, context)
        )
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
    round_id = round_of(parent_labels)
    if round_id is None or is_artifact_chat(child_labels):
        return {}
    if any(key in child_labels for key in BACKGROUND_LABELS):
        return {}
    return {ROUND_LABEL_KEY: round_id}


def helper_created(conversation: Any) -> None:
    """Record ``helper.started`` for a Helper session just created in a Round."""
    round_id = round_of(conversation.labels)
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
    round_id = round_of(saver.labels)
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


@dataclass(frozen=True)
class Stopped:
    """What a person's Stop came to.

    :param round_id: The Round it stops; only that Round's Helpers are interrupted.
    :param line: The Stop line for the Conversation's history; ``None`` when the Round had
        already settled, so nothing was stopped.
    """

    round_id: str
    line: str | None


async def stop_round(conversation: Any, live_helpers: Sequence[Any]) -> Stopped | None:
    """Stop a Conversation's Round (ADR 0029, "Stop stops the whole Round").

    The Round stopped is the Conversation's current one while it runs, else the newest Round
    one of *live_helpers* is still working in; others are left alone. ``stop.requested`` is
    recorded once, on that Round, and the Stop line is read from its folded record.

    :param conversation: The Conversation's row (a Helper's own Stop is not a Round's).
    :param live_helpers: The Conversation's Helpers still running.
    :returns: The Round and its line, or ``None`` outside a Round (every Helper is stopped,
        as before Rounds). Never raises.
    """
    current = round_of(conversation.labels)
    if RECORDER is None or current is None or conversation.kind == "sub_agent":
        return None
    try:
        rounds = [current]
        for helper in live_helpers:
            round_id = round_of(helper.labels)
            if round_id is not None and round_id not in rounds:
                rounds.append(round_id)
        views = {round_id: await RECORDER.view(round_id) for round_id in rounds}
        open_rounds = [r for r in rounds if views[r]["settled_at"] is None]
        if not open_rounds:
            return Stopped(current, None)
        target = (
            current
            if current in open_rounds
            else max(open_rounds, key=lambda r: views[r]["started_at"] or 0)
        )
        RECORDER.record(target, conversation.id, STOP_REQUESTED, PERSON, scope="round")
        return Stopped(target, (await RECORDER.view(target))["stop_line"])
    except Exception:
        _logger.warning("Stop not recorded for %s", conversation.id, exc_info=True)
        return Stopped(current, None)


async def stopped_wake(
    conversation_store: Any,
    conversation: Any,
    data: Mapping[str, Any],
    context: Mapping[str, Any] | None,
) -> bool:
    """Whether a message is a Helper's notice (its result, progress or flag) from a Round the
    person stopped. Stop ends a Round's pending wakes, so such a notice starts no turn.
    Never raises."""
    if RECORDER is None or _by_person(data) or not is_superside_chat(conversation.labels):
        return False
    try:
        _helper_id, round_id = await _notice_helper(conversation_store, conversation, context)
        return round_id is not None and (await RECORDER.view(round_id))["status"] == "stopped"
    except Exception:
        _logger.warning("wake of %s not checked against Stop", conversation.id, exc_info=True)
        return False


def _args(raw: Any) -> dict[str, Any]:
    if isinstance(raw, str):
        with contextlib.suppress(ValueError):
            raw = json.loads(raw)
    return raw if isinstance(raw, dict) else {}


def _ok(output: Any) -> bool:
    """Whether a tool's output reads as success: not the stopped marker, not ``{"error"}``, not
    ``{"ok": false}`` (a ``deck_check`` that found errors)."""
    if output == STOPPED_OUTPUT:
        return False
    parsed = _args(output)
    return not parsed.get("error") and parsed.get("ok") is not False


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

    async def observe(self, event: Mapping[str, Any], *, stopped: bool = False) -> None:
        """Record what *event* says happened, if this session's turn is in a Round.

        :param stopped: The engine stopped this turn. Its end reads ``stopped`` whatever the
            executor reported: a Helper interrupted while the executor called its turn done
            (the stop lost the race) is recorded stopped, never done.
        """
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
                self._end(turn, "stopped" if stopped else _TERMINAL[str(kind)])
        except Exception:
            _logger.warning("round event not recorded for %s", self._session_id, exc_info=True)

    async def _begin(self) -> None:
        self._turn = None
        if self._superside is False:
            return
        conv = await asyncio.to_thread(self._store.get_conversation, self._session_id)
        if conv is not None:
            self._superside = is_superside_chat(conv.labels)
        round_id = round_of(conv.labels) if conv is not None else None
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
