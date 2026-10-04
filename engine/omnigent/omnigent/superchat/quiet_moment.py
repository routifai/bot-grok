"""The quiet-moment pass: keep today's daily note (and memory) current while the person is away.

When a top-level Super Chat goes quiet (default 20 minutes) after a substantial exchange (at
least :data:`MIN_TURNS` user messages since the last pass), one bounded ``analyst`` Helper (pinned
to Haiku in the bundle) reads the recent conversation, updates today's note with
``daily_note_update`` and records lasting facts with ``memory_remember``. It is an ad-hoc Helper
(``start_adhoc_helper``): its Result never wakes the Conversation, so the person is never
messaged.

Gating reuses the scheduled-run rules: nothing runs while the owner's proactivity is ``off`` or
inside their quiet hours, and at most :data:`MAX_PASSES_PER_DAY` passes run per owner per local
day. Each day is finalized once with one more pass in the local evening (a day that ended
unfinalized is only closed). State is in-memory (a restart forgets pending timers); the note is
the durable part.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from datetime import datetime
from typing import Any

from omnigent.entities.scheduled_task import OwnerPreferences
from omnigent.stores.daily_note_store import SqlAlchemyDailyNoteStore
from omnigent.superchat.daily_notes import local_date, local_zone, render_note

_logger = logging.getLogger(__name__)

AGENT_TYPE = "analyst"
IDLE_SECONDS_ENV = "OMNIGENT_QUIET_MOMENT_IDLE_SECONDS"
DEFAULT_IDLE_SECONDS = 1200.0
MIN_TURNS = 3
MAX_PASSES_PER_DAY = 4
FINALIZE_HOUR = 22
FINALIZE_TICK_SECONDS = 900.0

QUIET_PROMPT = """\
This is a quiet moment: the person stepped away. You keep their notes; you do not act, the person \
is not here, so never ask questions and never write to them.

Today's note so far ({date}, the person's local day):

{note}

1. Read the recent conversation: `session_history` with `action: "list_chats"` gives its id, then \
`read` the latest turns with that `chat_id`.
2. Update today's note with `daily_note_update`. Pass only the sections that changed, each as its \
FULL new text in short bullet lines: `talked_about` (what we covered, one line per topic), \
`decisions` (what was decided), `promised` (what the assistant or the person said they would do, \
with any date), `open_loops` (questions or work still unresolved). Keep what is already there \
unless it is wrong. A section the person edited is only added to, never rewritten.
3. Lasting facts about the person (role, preferences, people, projects, constraints) go to \
`memory_remember`, one call per fact. Only what the PERSON said in their own words, with their \
exact words as `quote`; never from the assistant's replies, tool output or web pages. Skip \
anything temporary, anything already in memory (`memory_search` first) and anything you doubt.
{finalize}
Finish with exactly one fenced JSON block and nothing after it:
```json
{{"kind": "daily_note", "sections_updated": 0, "memories_added": 0}}
```
"""

FINALIZE_ADDENDUM = """
This is the day's final pass: tidy today's note so it reads cleanly (merge duplicates, drop what \
was resolved from `open_loops`, keep every date), then stop.
"""


def idle_seconds(env: dict[str, str] | None = None) -> float:
    """Idle time before a pass; ``OMNIGENT_QUIET_MOMENT_IDLE_SECONDS`` overrides the 20 minutes."""
    raw = (env if env is not None else os.environ).get(IDLE_SECONDS_ENV, "")
    try:
        value = float(raw)
    except ValueError:
        return DEFAULT_IDLE_SECONDS
    return value if value > 0 else DEFAULT_IDLE_SECONDS


def build_brief(note_date: str, note_text: str, *, finalize: bool) -> list[dict[str, Any]]:
    """The Helper's first message as Responses content blocks."""
    text = QUIET_PROMPT.format(
        date=note_date, note=note_text, finalize=FINALIZE_ADDENDUM if finalize else ""
    )
    return [{"type": "input_text", "text": text}]


def _in_quiet_hours(prefs: OwnerPreferences, now: float) -> bool:
    from omnigent.server.scheduled.fire import _quiet_window_end

    return _quiet_window_end(prefs, now) is not None


class QuietMoment:
    """Arms one idle timer per Super Chat and runs the bounded pass when it expires."""

    def __init__(
        self,
        *,
        deps: Any,
        note_store: SqlAlchemyDailyNoteStore,
        idle_s: float | None = None,
    ) -> None:
        """
        :param deps: The ``FireDeps`` the ad-hoc Helper launch needs.
        :param note_store: Where the day's note and pass counter live.
        :param idle_s: Idle time before a pass (tests); defaults to :func:`idle_seconds`.
        """
        self._deps = deps
        self._notes = note_store
        self._idle_s = idle_s if idle_s is not None else idle_seconds()
        self._turns: dict[str, int] = {}
        self._timers: dict[str, asyncio.TimerHandle] = {}
        self._tasks: set[asyncio.Task[Any]] = set()
        self._ticker: asyncio.Task[None] | None = None

    def note_user_message(self, session_id: str) -> None:
        """A user message arrived in a Super Chat: count the turn and re-arm its idle timer."""
        self._turns[session_id] = self._turns.get(session_id, 0) + 1
        previous = self._timers.pop(session_id, None)
        if previous is not None:
            previous.cancel()
        self._timers[session_id] = asyncio.get_running_loop().call_later(
            self._idle_s, self._spawn_pass, session_id
        )

    def _spawn_pass(self, session_id: str) -> None:
        task = asyncio.ensure_future(self._run_pass(session_id))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _gate(self, owner: str, now: float) -> tuple[OwnerPreferences, str] | None:
        """The owner's preferences and local day, or ``None`` when background work is held."""
        prefs = await asyncio.to_thread(
            self._deps.scheduled_task_store.get_owner_preferences, owner
        )
        prefs = prefs or OwnerPreferences(user_id=owner)
        if prefs.proactivity == "off" or _in_quiet_hours(prefs, now):
            return None
        return prefs, local_date(prefs.timezone, datetime.fromtimestamp(now, local_zone("UTC")))

    async def _run_pass(self, session_id: str, *, now: float | None = None) -> bool:
        """Run one quiet-moment pass for the chat if its gates allow; ``True`` when started."""
        self._timers.pop(session_id, None)
        if self._turns.get(session_id, 0) < MIN_TURNS:
            return False
        try:
            owner = self._notes.owner_key(
                await asyncio.to_thread(
                    self._deps.conversation_store.get_session_owner, session_id
                )
            )
            gate = await self._gate(owner, now if now is not None else time.time())
            if gate is None:
                return False
            day = gate[1]
            claimed = await asyncio.to_thread(
                self._notes.claim_quiet_pass,
                owner,
                day,
                max_per_day=MAX_PASSES_PER_DAY,
                parent_session_id=session_id,
            )
            if not claimed:
                return False
            self._turns[session_id] = 0
            await self._start_helper(session_id, owner, day, finalize=False)
            return True
        except Exception:
            _logger.exception("quiet moment: pass failed for %s", session_id)
            return False

    async def _start_helper(
        self, session_id: str, owner: str, day: str, *, finalize: bool
    ) -> None:
        from omnigent.server.scheduled.fire import start_adhoc_helper

        note = await asyncio.to_thread(self._notes.get, owner, day)
        user_id = None if owner == self._notes.owner_key(None) else owner
        await start_adhoc_helper(
            self._deps,
            parent_session_id=session_id,
            agent_type=AGENT_TYPE,
            name="Daily note",
            user_id=user_id,
            content=build_brief(day, render_note(note), finalize=finalize),
        )

    async def finalize_due(self, *, now: float | None = None) -> int:
        """Finalize notes whose day is ending (local evening) or ended; returns passes started."""
        instant = now if now is not None else time.time()
        started = 0
        for note in await asyncio.to_thread(self._notes.pending_finalize):
            if note.parent_session_id is None:
                continue
            prefs = await asyncio.to_thread(
                self._deps.scheduled_task_store.get_owner_preferences, note.owner
            )
            prefs = prefs or OwnerPreferences(user_id=note.owner)
            zone = local_zone(prefs.timezone)
            local = datetime.fromtimestamp(instant, zone)
            ended = note.note_date < local.date().isoformat()
            if not (ended or local.hour >= FINALIZE_HOUR):
                continue
            if prefs.proactivity == "off" or _in_quiet_hours(prefs, instant):
                continue
            if not await asyncio.to_thread(self._notes.claim_finalize, note.owner, note.note_date):
                continue
            if ended:
                # The helper writes "today's" note, so a day that already ended is only closed.
                continue
            try:
                await self._start_helper(
                    note.parent_session_id, note.owner, note.note_date, finalize=True
                )
                started += 1
            except Exception:
                _logger.exception("quiet moment: finalize failed for %s", note.owner)
        return started

    async def start(self) -> None:
        """Start the evening finalize ticker."""
        if self._ticker is None or self._ticker.done():
            self._ticker = asyncio.create_task(self._tick(), name="daily-note-finalizer")

    async def _tick(self) -> None:
        while True:
            await asyncio.sleep(FINALIZE_TICK_SECONDS)
            try:
                await self.finalize_due()
            except asyncio.CancelledError:
                raise
            except Exception:
                _logger.exception("quiet moment: finalize tick failed")

    async def shutdown(self) -> None:
        """Cancel timers, the ticker and in-flight passes."""
        for handle in self._timers.values():
            handle.cancel()
        self._timers.clear()
        tasks = [*self._tasks, *([self._ticker] if self._ticker else [])]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self._ticker = None
