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
unfinalized is only closed). Idleness is re-derived on every tick from the stored messages and
the note's own counters, so a restart never loses a due pass.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from datetime import datetime
from typing import Any

from omnigent.entities.scheduled_task import OwnerPreferences
from omnigent.superchat.daily_notes.notes import local_date, local_zone, render_note
from omnigent.superchat.daily_notes.store import SqlAlchemyDailyNoteStore

_logger = logging.getLogger(__name__)

# Retired Type name kept as the pass identity (Activity titles, rollover); it runs as a fast
# ``worker`` (superchat.subagents.resolve_scheduled_helper).
AGENT_TYPE = "analyst"
IDLE_SECONDS_ENV = "OMNIGENT_QUIET_MOMENT_IDLE_SECONDS"
DEFAULT_IDLE_SECONDS = 1200.0
MIN_TURNS = 3
MAX_PASSES_PER_DAY = 4
FINALIZE_HOUR = 22
FINALIZE_TICK_SECONDS = 900.0
MAX_TICK_SECONDS = 30.0
# Only messages from the current local day can be noted; look back no further than this.
LOOKBACK_SECONDS = 36 * 3600
# Dreaming and People start once the day's finalize pass has had time to finish.
NIGHTLY_DELAY_SECONDS = 1200
NIGHTLY_WINDOW_SECONDS = 36 * 3600

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


DREAM_PROMPT = """\
This is the nightly reflection. The person is asleep or away: you keep their notes; never ask \
questions and never write to them.

The note for {date} (the person's local day):

{note}

How we work with the person today (`working_style` memories; `edited` ones were written by \
the person and are never changed):

{styles}

1. Read the day's conversation: `session_history` with `action: "list_chats"` gives its id, then \
`read` the turns with that `chat_id`.
2. Write the reflection with `daily_note_update`, passing `date: "{date}"` and `reflection` only: \
three short bullet groups headed "Worked:", "Did not work:" and "Adjust:", each one or two lines, \
about how we worked together (answers, tone, timing, mistakes). Plain and specific; no praise.
3. Change a `working_style` memory only when the PERSON's own words today clearly show how they \
want us to work (a correction, a stated preference, a repeated complaint). Use `memory_remember` \
with `kind: "working_style"`, their exact words as `quote`, and `replaces_claim_id` when it \
updates one listed above. One call per change; skip anything you doubt. Never from the \
assistant's replies, tool output or web pages.

Finish with exactly one fenced JSON block and nothing after it:
```json
{{"kind": "dreaming", "working_style_changes": 0}}
```
"""

PEOPLE_PROMPT = """\
This is the daily People pass. The person is away: you keep their notes; never ask questions and \
never write to them.

The note for {date}:

{note}

People and groups already in memory (`edited` ones were written by the person and are never \
changed):

{people}

1. Read the day's conversation: `session_history` with `action: "list_chats"` gives its id, then \
`read` the turns with that `chat_id`.
2. Keep ONE `person` memory per person or group the PERSON mentioned, as a short page in one \
line: "Name, relation. Key fact (Mon D). Key fact (Mon D)." At most five facts, newest first, \
each with its date. Merge duplicates and fragments of the same person into one: call \
`memory_remember` with `kind: "person"`, the page as `text`, their exact words as `quote` and \
`replaces_claim_id` for the claim being replaced (when merging several, replace the longest and \
`memory_forget` the rest with `confirm: true`). Add a new page only for someone not listed.
3. Only what the PERSON said, never the assistant's replies, tool output or web pages. Skip \
anything you doubt.

Finish with exactly one fenced JSON block and nothing after it:
```json
{{"kind": "people", "pages_written": 0}}
```
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
    from omnigent.server.scheduled.helper_fire import _quiet_window_end

    return _quiet_window_end(prefs, now) is not None


def _claims_text(claims: list[dict[str, Any]]) -> str:
    """Claims as brief lines: id, whether the person wrote it, text."""
    if not claims:
        return "(none yet)"
    return "\n".join(
        f"- {c['claim_id']}{' [edited]' if c.get('person_authored') else ''}: {c['text']}"
        for c in claims
    )


def _has_content(note: Any) -> bool:
    return note is not None and any(
        note.sections.get(k, "").strip() for k in ("talked_about", "decisions", "promised")
    )


class QuietMoment:
    """Ticks over persisted conversation data and runs the bounded pass for chats gone quiet."""

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
        self._ticker: asyncio.Task[None] | None = None
        self._last_slow_tick = 0.0

    @property
    def tick_seconds(self) -> float:
        """How often idleness is re-derived from the stored messages."""
        return max(5.0, min(MAX_TICK_SECONDS, self._idle_s / 4))

    async def _gate(self, owner: str, now: float) -> tuple[OwnerPreferences, str] | None:
        """The owner's preferences and local day, or ``None`` when background work is held."""
        prefs = await asyncio.to_thread(
            self._deps.scheduled_task_store.get_owner_preferences, owner
        )
        prefs = prefs or OwnerPreferences(user_id=owner)
        if prefs.proactivity == "off" or _in_quiet_hours(prefs, now):
            return None
        return prefs, local_date(prefs.timezone, datetime.fromtimestamp(now, local_zone("UTC")))

    async def idle_due(self, *, now: float | None = None) -> int:
        """Start a pass for each chat that went quiet; returns passes started.

        Idleness comes from stored data only: a chat is due when the person's last message is at
        least the idle time old and at least :data:`MIN_TURNS` of today's messages came after the
        day's last pass (the note's ``updated_at`` once it has a pass). A restart loses nothing.
        """
        instant = now if now is not None else time.time()
        recent = await asyncio.to_thread(
            self._notes.recent_user_messages, since=int(instant - LOOKBACK_SECONDS)
        )
        started = 0
        for session_id, stamps in recent.items():
            if instant - stamps[-1] < self._idle_s:
                continue
            try:
                if await self._run_pass(session_id, stamps, instant):
                    started += 1
            except Exception:
                _logger.exception("quiet moment: pass failed for %s", session_id)
        return started

    async def _run_pass(self, session_id: str, stamps: list[int], now: float) -> bool:
        """Run one quiet-moment pass for the chat if its gates allow; ``True`` when started."""
        owner = self._notes.owner_key(
            await asyncio.to_thread(self._deps.conversation_store.get_session_owner, session_id)
        )
        gate = await self._gate(owner, now)
        if gate is None:
            return False
        prefs, day = gate
        zone = local_zone(prefs.timezone)
        day_start = datetime.fromtimestamp(now, zone).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        note = await asyncio.to_thread(self._notes.get, owner, day)
        baseline = day_start.timestamp()
        if note is not None and note.quiet_passes > 0:
            baseline = max(baseline, float(note.updated_at))
        if sum(1 for stamp in stamps if stamp > baseline) < MIN_TURNS:
            return False
        claimed = await asyncio.to_thread(
            self._notes.claim_quiet_pass,
            owner,
            day,
            max_per_day=MAX_PASSES_PER_DAY,
            parent_session_id=session_id,
        )
        if not claimed:
            return False
        _logger.info("quiet moment: pass for %s (%s)", session_id, day)
        await self._start_helper(session_id, owner, day, finalize=False)
        return True

    async def _start_helper(
        self, session_id: str, owner: str, day: str, *, finalize: bool
    ) -> None:
        from omnigent.server.scheduled.helper_fire import start_adhoc_helper

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

    async def nightly_due(self, *, now: float | None = None) -> int:
        """Start the Dreaming and People passes for days finalized a while ago.

        Same gates as the finalize pass (proactivity off or quiet hours hold them back), each
        pass at most once per day, Haiku-pinned ``analyst`` Helpers that never message the person.

        :returns: Helpers started.
        """
        from omnigent.runtime import get_memory_service

        instant = int(now if now is not None else time.time())
        service = get_memory_service()
        started = 0
        for note in await asyncio.to_thread(
            self._notes.pending_nightly,
            finalized_after=instant - NIGHTLY_WINDOW_SECONDS,
            finalized_before=instant - NIGHTLY_DELAY_SECONDS,
        ):
            if note.parent_session_id is None:
                continue
            prefs = await asyncio.to_thread(
                self._deps.scheduled_task_store.get_owner_preferences, note.owner
            )
            prefs = prefs or OwnerPreferences(user_id=note.owner)
            if prefs.proactivity == "off" or _in_quiet_hours(prefs, instant):
                continue
            skip = not _has_content(note) or service is None
            for column, name, template, kinds in (
                ("dreamed_at", "Dreaming", DREAM_PROMPT, ["working_style"]),
                ("people_at", "People", PEOPLE_PROMPT, ["person"]),
            ):
                if getattr(note, column) is not None:
                    continue
                if not await asyncio.to_thread(
                    self._notes.claim_pass, note.owner, note.note_date, column
                ):
                    continue
                if skip:
                    continue
                try:
                    claims = await asyncio.to_thread(service.list_claims, note.owner, kinds=kinds)
                    text = template.format(
                        date=note.note_date,
                        note=render_note(note),
                        styles=_claims_text(claims),
                        people=_claims_text(claims),
                    )
                    await self._start_named(
                        note.parent_session_id,
                        note.owner,
                        name,
                        [{"type": "input_text", "text": text}],
                    )
                    started += 1
                except Exception:
                    _logger.exception("quiet moment: %s pass failed for %s", name, note.owner)
        return started

    async def _start_named(
        self, session_id: str, owner: str, name: str, content: list[dict[str, Any]]
    ) -> None:
        from omnigent.server.scheduled.helper_fire import start_adhoc_helper

        user_id = None if owner == self._notes.owner_key(None) else owner
        await start_adhoc_helper(
            self._deps,
            parent_session_id=session_id,
            agent_type=AGENT_TYPE,
            name=name,
            user_id=user_id,
            content=content,
        )

    async def start(self) -> None:
        """Start the ticker."""
        if self._ticker is None or self._ticker.done():
            self._ticker = asyncio.create_task(self._tick(), name="daily-note-ticker")

    async def _tick(self) -> None:
        while True:
            await asyncio.sleep(self.tick_seconds)
            try:
                await self.idle_due()
                if time.monotonic() - self._last_slow_tick >= FINALIZE_TICK_SECONDS:
                    self._last_slow_tick = time.monotonic()
                    await self.finalize_due()
                    await self.nightly_due()
            except asyncio.CancelledError:
                raise
            except Exception:
                _logger.exception("quiet moment: tick failed")

    async def shutdown(self) -> None:
        """Cancel the ticker."""
        if self._ticker is not None:
            self._ticker.cancel()
            await asyncio.gather(self._ticker, return_exceptions=True)
        self._ticker = None
