"""Topic watch: one hidden scheduled task per person and the run each fire makes.

Each person with a Conversation gets one task of kind ``topic_watch`` bound to it, kept by
:meth:`TopicWatch.ensure` (idempotent, re-checked every :data:`ENSURE_SECONDS`): hourly on
weekdays during working hours (8:00-18:00 local, the person's preference timezone), at a minute
drawn from the person's id so runs spread out. The kind never shows among Automations (the web
lists only ``automation``).

A fire takes the scheduled path's gates (proactivity ``off`` skips, quiet hours defer to their
end) and then runs :meth:`TopicWatch.run` in the engine (``register_engine_run``): no Helper and
no host. Stages 2, 3 and 5 are code; stage 4 is one Light-model call. Only an item worth saying
now wakes the Conversation (:func:`~omnigent.server.scheduled.helper_fire.wake_conversation`),
with a notice the assistant turns into its own words.

The topics, marks and mutes come from other capabilities through :class:`Seams`, resolved by
import path at each run; with no topics capability the run is skipped as
``topics_unavailable``.
"""

from __future__ import annotations

import asyncio
import hashlib
import importlib
import inspect
import logging
import time
import uuid
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Protocol
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from omnigent.entities import OwnerPreferences
from omnigent.server.auth import RESERVED_USER_LOCAL
from omnigent.superchat.topic_watch.judge import (
    JUDGE_INSTRUCTIONS,
    MAX_JUDGE_ITEMS,
    build_input,
    parse_verdicts,
)
from omnigent.superchat.topic_watch.notice import notice_text
from omnigent.superchat.topic_watch.rules import (
    DROP,
    HOLD,
    MARK,
    MESSAGE,
    Item,
    Match,
    Verdict,
    WatchedTopic,
    common_terms,
    decide,
    match,
    noise_reason,
    norm_term,
    term_hits,
    watched_topic,
)
from omnigent.superchat.topic_watch.sources import Source, SourceUnavailable
from omnigent.superchat.topic_watch.store import SeenRow, SqlAlchemyTopicWatchStore

_logger = logging.getLogger(__name__)

TASK_KIND = "topic_watch"
TASK_NAME = "Topic watch"
#: Working hours (local, weekdays) the watch runs in, hourly: the RRULE minimum is one hour.
WORK_HOURS = range(8, 18)
WORK_DAYS = "MO,TU,WE,TH,FR"
#: How often the tasks are re-checked (a new Conversation, a moved timezone).
ENSURE_SECONDS = 1800.0
FIRST_ENSURE_SECONDS = 60.0
#: The whole budget of the judge's call.
JUDGE_TIMEOUT_SECONDS = 90.0
_STRENGTH = {"strong": 3, "medium": 2, "weak": 1}

#: ``seam -> "module:attribute"``, resolved at each run so no capability imports another. The
#: topics capability (ADR 0035) exposes the first two; the outbox (ADR 0036) registers the mutes
#: reader of its *Not useful* rows in core.
SEAM_PATHS = {
    "list_watched_topics": "omnigent.superchat.topics:list_watched_topics",
    "mark_topic_new": "omnigent.superchat.topics:mark_topic_new",
    "topic_mutes": "omnigent.superchat.feature:list_mutes",
}


class JudgeCaller(Protocol):
    """One model call: instructions plus a user turn, returning raw text."""

    async def __call__(self, *, instructions: str, input_text: str) -> str: ...


def _resolve(path: str) -> Callable[..., Any] | None:
    """The callable at ``"module:attribute"``, or ``None`` when it does not exist (yet)."""
    module, _, name = path.partition(":")
    try:
        found = getattr(importlib.import_module(module), name, None)
    except ImportError:
        return None
    return found if callable(found) else None


@dataclass(frozen=True)
class Seams:
    """What topic watch reads from other capabilities.

    :param list_watched_topics: ``owner -> [topic]``: open topics touched within 7 days, each
        ``{key, title, left_off, open, watch: {people, terms, refs, web}, last_touched_at}``.
    :param mark_topic_new: ``(owner, key, line, at)``: give the topic its "New" line.
    :param topic_mutes: ``owner -> [{topic_key, sender?, term?}]`` from *Not useful*; none when
        ``None``.
    """

    list_watched_topics: Callable[..., Any] | None = None
    mark_topic_new: Callable[..., Any] | None = None
    topic_mutes: Callable[..., Any] | None = None

    @classmethod
    def resolve(cls, paths: Mapping[str, str] = SEAM_PATHS) -> Seams:
        """Each seam from its import path (``None`` where nothing is there)."""
        return cls(**{name: _resolve(path) for name, path in paths.items()})


async def _call(fn: Callable[..., Any], *args: Any) -> Any:
    """Call a seam, sync (in a thread) or async."""
    if inspect.iscoroutinefunction(fn):
        return await fn(*args)
    result = await asyncio.to_thread(fn, *args)
    return await result if inspect.isawaitable(result) else result


def task_id(owner: str) -> str:
    """The id of the owner's watch task: derived, so every replica's ticker makes one row."""
    return uuid.uuid5(uuid.NAMESPACE_OID, f"omnigent-topic-watch\0{owner}").hex


def task_rrule(owner: str) -> str:
    """The watch's schedule: weekdays, every working hour, at the owner's own minute."""
    minute = int(hashlib.sha256(owner.encode()).hexdigest(), 16) % 60
    hours = ",".join(str(h) for h in WORK_HOURS)
    return f"FREQ=DAILY;BYDAY={WORK_DAYS};BYHOUR={hours};BYMINUTE={minute}"


def _zone(name: str | None) -> ZoneInfo:
    try:
        return ZoneInfo(name or "UTC")
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo("UTC")


def _day_start(prefs: OwnerPreferences, now: float) -> int:
    local = datetime.fromtimestamp(now, _zone(prefs.timezone))
    return int(local.replace(hour=0, minute=0, second=0, microsecond=0).timestamp())


@dataclass
class _Run:
    """One run's tallies and record, filled as the stages go."""

    owner: str
    task_id: str
    started_at: int
    counts: dict[str, int] = field(
        default_factory=lambda: dict.fromkeys(
            (
                "collected",
                "seen",
                "noise",
                "unmatched",
                "matched",
                "over_cap",
                "judged",
                "invalid",
                "dropped",
                "surfaced",
                "marked",
                "held",
            ),
            0,
        )
    )
    sources: dict[str, str] = field(default_factory=dict)
    items: list[dict[str, Any]] = field(default_factory=list)
    rows: list[SeenRow] = field(default_factory=list)
    #: The watched terms (normalized) this run counted, and each counted item's hits among them.
    watched: list[str] = field(default_factory=list)
    term_hits: dict[str, set[str]] = field(default_factory=dict)
    #: ``term -> why`` for the terms treated as common this run.
    common: dict[str, str] = field(default_factory=dict)

    def term_counts(self) -> dict[str, tuple[int, int]]:
        """``term -> (items containing it, items seen)`` over the items this run records.

        Only items with an outcome row count, so an item that comes back (the judge failed and
        the cursors stayed) is counted once, on the run that records it.
        """
        recorded = [r.item_key for r in self.rows if r.item_key in self.term_hits]
        return {
            term: (sum(term in self.term_hits[key] for key in recorded), len(recorded))
            for term in self.watched
        }


class TopicWatch:
    """Keeps each person's hidden ``topic_watch`` task and runs it."""

    def __init__(
        self,
        *,
        store: SqlAlchemyTopicWatchStore,
        tasks: Any,
        conversations: Any,
        sources: Sequence[Source],
        scheduler: Callable[[], Any | None],
        fire_deps: Callable[[], Any | None],
        judge_caller: Callable[[str], Awaitable[JudgeCaller | None]] | None = None,
        seams: Callable[[], Seams] = Seams.resolve,
        own_terms: Callable[[str], Sequence[str]] | None = None,
    ) -> None:
        """
        :param store: Cursors, seen-set, ledger and run records.
        :param tasks: The scheduled task store (tasks and owner preferences).
        :param conversations: The conversation store.
        :param sources: The stage 2 adapters, in reading order.
        :param scheduler: Returns the running scheduler, or ``None``.
        :param fire_deps: Returns the fire path's ``FireDeps`` (to wake a Conversation).
        :param judge_caller: ``owner -> caller`` of the owner's Light model; defaults to the
            background caller memory upkeep and titles use.
        :param seams: Returns the other capabilities' functions (resolved per run).
        :param own_terms: ``owner -> terms`` naming the person's own organisation (blocking);
            defaults to :func:`omnigent.memory.identity.own_org_terms`.
        """
        self._store = store
        self._tasks = tasks
        self._conversations = conversations
        self._sources = list(sources)
        self._scheduler = scheduler
        self._fire_deps = fire_deps
        self._judge_caller = judge_caller or _background_caller
        self._seams = seams
        self._own_terms = own_terms or _own_org_terms
        self._ticker: asyncio.Task[None] | None = None

    # ------------------------------------------------------------------ the hidden tasks

    def ensure(self) -> tuple[list[Any], list[str]]:
        """Blocking: one active ``topic_watch`` task per person, bound to their Conversation.

        The person's Conversation is their newest unarchived one carrying the Conversation
        label. A missing task is created; one bound elsewhere, on another timezone or another
        rule is updated; duplicates are deleted.

        :returns: ``(tasks created or changed, ids of tasks deleted)``, for the scheduler.
        """
        from omnigent.server.scheduled.rrule import validate_rrule
        from omnigent.superchat.muse import MUSE_LABEL_KEY

        chats: dict[str, Any] = {}
        for session_id in self._store.conversations(MUSE_LABEL_KEY):
            owner = self._conversations.get_session_owner(session_id, owner_only=True)
            if owner is None or owner in chats:
                continue
            conv = self._conversations.get_conversation(session_id)
            if conv is not None and conv.agent_id is not None:
                chats[owner] = conv
        changed: list[Any] = []
        removed: list[str] = []
        for owner, conv in chats.items():
            user_id = None if owner == RESERVED_USER_LOCAL else owner
            prefs = self._tasks.get_owner_preferences(owner) or OwnerPreferences(user_id=owner)
            rrule = task_rrule(owner)
            validate_rrule(rrule)
            derived = task_id(owner)
            mine = sorted(
                (
                    t
                    for t in self._tasks.list(owner_user_id=user_id)
                    if t.kind == TASK_KIND and t.user_id == user_id and t.state != "deleted"
                ),
                key=lambda t: t.id != derived,
            )
            for extra in mine[1:]:
                self._tasks.delete(extra.id)
                removed.append(extra.id)
            task = mine[0] if mine else None
            if task is None:
                try:
                    task = self._tasks.create(
                        scheduled_task_id=derived,
                        name=TASK_NAME,
                        prompt="",
                        rrule=rrule,
                        user_id=user_id,
                        agent_id=conv.agent_id,
                        timezone=prefs.timezone or "UTC",
                        parent_session_id=conv.id,
                        kind=TASK_KIND,
                    )
                except Exception:
                    # Another replica's ticker made it: the derived id makes this insert fail.
                    if self._tasks.get(derived) is None:
                        raise
                    continue
            elif (task.parent_session_id, task.timezone, task.rrule, task.agent_id) != (
                conv.id,
                prefs.timezone or "UTC",
                rrule,
                conv.agent_id,
            ):
                task = self._tasks.update(
                    task.id,
                    parent_session_id=conv.id,
                    timezone=prefs.timezone or "UTC",
                    rrule=rrule,
                    agent_id=conv.agent_id,
                )
            else:
                continue
            if task is not None:
                changed.append(task)
        return changed, removed

    async def ensure_now(self) -> int:
        """Keep the tasks (:meth:`ensure`) and sync the scheduler's timers on the event loop.

        :returns: Tasks created, changed or deleted.
        """
        changed, removed = await asyncio.to_thread(self.ensure)
        scheduler = self._scheduler()
        if scheduler is not None:
            for task_id in removed:
                scheduler.remove(task_id)
            for task in changed:
                scheduler.update(task)
        return len(changed) + len(removed)

    async def start(self) -> None:
        """Start the ticker that keeps the tasks."""
        if self._ticker is None or self._ticker.done():
            self._ticker = asyncio.create_task(self._tick(), name="topic-watch-tasks")

    async def _tick(self) -> None:
        delay = FIRST_ENSURE_SECONDS
        while True:
            await asyncio.sleep(delay)
            delay = ENSURE_SECONDS
            try:
                changed = await self.ensure_now()
                if changed:
                    _logger.info("topic watch: %d task(s) created or updated", changed)
            except asyncio.CancelledError:
                raise
            except Exception:
                _logger.exception("topic watch: keeping the tasks failed")

    async def shutdown(self) -> None:
        """Cancel the ticker."""
        if self._ticker is not None:
            self._ticker.cancel()
            await asyncio.gather(self._ticker, return_exceptions=True)
        self._ticker = None

    # ------------------------------------------------------------------ one run

    async def run(self, task: Any) -> Any:
        """One fire of the owner's watch: collect, match, judge, decide; record the run.

        :returns: The ``EngineRunOutcome`` the scheduled run row records.
        """
        from omnigent.server.scheduled.helper_fire import _quiet_window_end

        now = time.time()
        owner = task.user_id or RESERVED_USER_LOCAL
        run = _Run(owner, task.id, int(now))
        seams = self._seams()
        if seams.list_watched_topics is None:
            return await self._finish(run, {}, "skipped", "topics_unavailable")
        prefs = await asyncio.to_thread(self._tasks.get_owner_preferences, owner)
        prefs = prefs or OwnerPreferences(user_id=owner)
        quiet = _quiet_window_end(prefs, now) is not None
        ledger = await asyncio.to_thread(
            self._store.ledger, owner, day_start=_day_start(prefs, now)
        )
        if not quiet:
            await self._deliver_held(task, run)

        try:
            raw = await _call(seams.list_watched_topics, owner) or []
        except Exception:
            _logger.exception("topic watch: reading the topics of %s failed", owner)
            return await self._finish(run, {}, "failed", "topics_failed")
        topics = [t for t in (watched_topic(r) for r in raw if isinstance(r, Mapping)) if t]
        if not topics:
            return await self._finish(run, {}, "succeeded", "no_topics")
        titles = {t.key: t.title for t in topics}
        mutes: list[Mapping[str, Any]] = []
        if seams.topic_mutes is not None:
            try:
                mutes = [
                    m
                    for m in await _call(seams.topic_mutes, owner) or ()
                    if isinstance(m, Mapping)
                ]
            except Exception:
                _logger.warning(
                    "topic watch: mutes of %s unreadable; none applied", owner, exc_info=True
                )

        items, cursors = await self._collect(owner, topics, run)
        batch = await self._match(owner, items, topics, mutes, run)
        if not batch:
            return await self._finish(run, cursors, "succeeded", None)

        caller = await self._judge_caller(owner)
        if caller is None:
            # Nothing judged: leave the cursors so the same items come back once a model can.
            return await self._finish(run, {}, "skipped", "no_model")
        started = time.perf_counter()
        try:
            answer = await asyncio.wait_for(
                caller(instructions=JUDGE_INSTRUCTIONS, input_text=build_input(batch, topics)),
                timeout=JUDGE_TIMEOUT_SECONDS,
            )
        except Exception as exc:  # noqa: BLE001 - recorded; the items come back next run
            _logger.warning("topic watch judge for %s failed: %s", owner, type(exc).__name__)
            return await self._finish(run, {}, "failed", "judge_failed")
        verdicts, invalid = parse_verdicts(answer, batch)
        run.counts["judged"], run.counts["invalid"] = len(batch), invalid
        _logger.info(
            "topic watch judge for %s: %d item(s), %d invalid, %.1fs",
            owner,
            len(batch),
            invalid,
            time.perf_counter() - started,
        )
        for index, (item, found) in enumerate(batch):
            verdict = verdicts.get(index)
            if verdict is None:
                run.rows.append(SeenRow(item.key, item.source, "invalid", item.thread))
                continue
            decision = decide(
                verdict,
                item,
                now=int(now),
                quiet=quiet,
                proactivity=prefs.proactivity,
                ledger=ledger,
            )
            await self._apply(task, run, item, found, verdict, decision, titles, seams)
        return await self._finish(run, cursors, "succeeded", None)

    async def _collect(
        self, owner: str, topics: Sequence[Any], run: _Run
    ) -> tuple[list[Item], dict[str, str]]:
        """Stage 2: what changed since each source's cursor; each source's status is recorded."""
        cursors = await asyncio.to_thread(self._store.cursors, owner)
        items: list[Item] = []
        moved: dict[str, str] = {}
        for source in self._sources:
            try:
                got, cursor = await source.changes_since(
                    owner, cursors.get(source.name), topics=topics
                )
            except SourceUnavailable as exc:
                run.sources[source.name] = exc.reason
                continue
            except Exception:
                _logger.exception("topic watch: source %s failed for %s", source.name, owner)
                run.sources[source.name] = "error"
                continue
            run.sources[source.name] = f"read {len(got)}"
            items.extend(got)
            moved[source.name] = cursor
        run.counts["collected"] = len(items)
        return items, moved

    async def _match(
        self,
        owner: str,
        items: Sequence[Item],
        topics: Sequence[Any],
        mutes: Sequence[Mapping[str, Any]],
        run: _Run,
    ) -> list[tuple[Item, Match]]:
        """Stage 3: drop seen items and noise, count the terms, match the rest.

        :returns: The batch the judge reads.
        """
        seen = await asyncio.to_thread(self._store.seen, owner, [i.key for i in items])
        fresh: list[Item] = []
        taken: set[str] = set()
        for item in items:
            if item.key in seen or item.key in taken:
                run.counts["seen"] += 1
                continue
            taken.add(item.key)
            if noise_reason(item) is not None:
                run.counts["noise"] += 1
                run.rows.append(SeenRow(item.key, item.source, "noise", item.thread))
                continue
            fresh.append(item)
        common = await self._common_terms(owner, fresh, topics, run)
        matched: list[tuple[Item, Match]] = []
        for item in fresh:
            found = match(item, topics, mutes, common)
            if found is None:
                run.counts["unmatched"] += 1
                run.rows.append(SeenRow(item.key, item.source, "unmatched", item.thread))
                continue
            matched.append((item, found))
        run.counts["matched"] = len(matched)
        matched.sort(key=lambda pair: (-_STRENGTH[pair[1].strength], -pair[0].at))
        for item, found in matched[MAX_JUDGE_ITEMS:]:
            run.counts["over_cap"] += 1
            run.rows.append(
                SeenRow(item.key, item.source, "over_cap", item.thread, found.topic_key)
            )
        return matched[:MAX_JUDGE_ITEMS]

    async def _common_terms(
        self, owner: str, fresh: Sequence[Item], topics: Sequence[WatchedTopic], run: _Run
    ) -> dict[str, str]:
        """The terms that are common for *owner* this run, with why (recorded on *run*).

        The term counts are brought up to date with this run's items first: each item the
        person received (web items are fetched by the terms themselves, so they never count)
        counts once per watched term, and a term's share is over the items seen while watched.
        """
        run.watched = sorted({t for t in (norm_term(x) for p in topics for x in p.terms) if t})
        for item in fresh:
            if item.topic_key is None:
                run.term_hits[item.key] = term_hits(item, run.watched)
        stored = await asyncio.to_thread(self._store.term_counts, owner, run.watched)
        counted = len(run.term_hits)
        stats = {
            term: (
                stored.get(term, (0, 0))[0] + sum(term in hits for hits in run.term_hits.values()),
                stored.get(term, (0, 0))[1] + counted,
            )
            for term in run.watched
        }
        try:
            own = list(await asyncio.to_thread(self._own_terms, owner))
        except Exception:
            _logger.warning("topic watch: own organisation of %s unreadable", owner, exc_info=True)
            own = []
        run.common = common_terms(topics, own=own, stats=stats)
        return run.common

    async def _apply(
        self,
        task: Any,
        run: _Run,
        item: Item,
        found: Match,
        verdict: Verdict,
        decision: Any,
        titles: Mapping[str, str],
        seams: Seams,
    ) -> None:
        """Stage 5's outcome: drop, mark the topic, hold for quiet hours, or message now."""
        payload = {
            "topic_key": verdict.topic_key,
            "topic_title": titles.get(verdict.topic_key, verdict.topic_key),
            "source": item.source,
            "item_title": item.title,
            "sender": item.sender,
            "at": item.at,
            "why": verdict.why,
            "change": verdict.change,
        }
        action, reason = decision.action, decision.reason
        if action == MESSAGE and not await self._deliver(task, payload):
            action, reason = MARK, f"{reason}; could not be said, marked"
        # A message (said now or held) marks its topic too: the New line shows either way.
        if action != DROP and not await self._mark(seams, run.owner, verdict, item):
            reason = f"{reason}; mark failed"
        outcome = {DROP: "dropped", MARK: "marked", HOLD: "held", MESSAGE: "messaged"}[action]
        run.counts[{"messaged": "surfaced"}.get(outcome, outcome)] += 1
        run.rows.append(
            SeenRow(
                item.key,
                item.source,
                outcome,
                item.thread,
                verdict.topic_key,
                verdict.why if action != DROP else None,
                payload if action == HOLD else None,
            )
        )
        run.items.append(
            {
                "item": item.key,
                "title": item.title[:120],
                "topic": verdict.topic_key,
                "match": f"{found.strength}: {found.reason}",
                "relevance": verdict.relevance,
                "change": verdict.change,
                "urgency": verdict.urgency,
                "why": verdict.why,
                "action": outcome,
                "reason": reason,
            }
        )

    async def _mark(self, seams: Seams, owner: str, verdict: Verdict, item: Item) -> bool:
        if seams.mark_topic_new is None:
            return False
        try:
            await _call(seams.mark_topic_new, owner, verdict.topic_key, verdict.why, item.at)
            return True
        except Exception:
            _logger.exception("topic watch: marking %s failed for %s", verdict.topic_key, owner)
            return False

    async def _deliver(self, task: Any, payload: Mapping[str, Any]) -> bool:
        """Wake the person's Conversation with the item's notice; ``False`` when it could not."""
        from omnigent.server.scheduled.helper_fire import wake_conversation

        deps = self._fire_deps()
        if deps is None or task.parent_session_id is None:
            return False
        context = {
            "proactive": {
                "kind": TASK_KIND,
                "topic_key": payload.get("topic_key"),
                "urgency": "now",
            }
        }
        try:
            await wake_conversation(
                deps,
                task,
                [{"type": "input_text", "text": notice_text(payload)}],
                context=context,
            )
        except Exception:
            _logger.exception("topic watch: could not wake %s", task.parent_session_id)
            return False
        return True

    async def _deliver_held(self, task: Any, run: _Run) -> None:
        """Say the messages quiet hours held, oldest first; one that fails stays held."""
        for row in await asyncio.to_thread(self._store.held, run.owner):
            if row.payload is None or not await self._deliver(task, row.payload):
                continue
            await asyncio.to_thread(self._store.set_outcome, run.owner, row.item_key, "messaged")
            run.counts["surfaced"] += 1
            run.items.append(
                {
                    "item": row.item_key,
                    "topic": row.topic_key,
                    "why": row.line,
                    "action": "messaged",
                    "reason": "held for quiet hours, said after",
                }
            )

    async def _finish(
        self, run: _Run, cursors: dict[str, str], status: str, reason: str | None
    ) -> Any:
        """Write the run (outcomes, moved cursors, record), log its counts, return its outcome."""
        from omnigent.server.scheduled.helper_fire import EngineRunOutcome

        await asyncio.to_thread(
            self._store.finish_run,
            run.owner,
            rows=run.rows,
            cursors=cursors,
            terms=run.term_counts(),
            run={
                "scheduled_task_id": run.task_id,
                "status": status,
                "reason": reason,
                "counts": run.counts,
                "detail": {"sources": run.sources, "common": run.common, "items": run.items},
                "started_at": run.started_at,
            },
        )
        _logger.info(
            "topic watch for %s: %s%s; %s; sources %s",
            run.owner,
            status,
            f" ({reason})" if reason else "",
            ", ".join(f"{k} {v}" for k, v in run.counts.items() if v) or "nothing new",
            ", ".join(f"{k} {v}" for k, v in run.sources.items()) or "none read",
        )
        if status == "succeeded":
            return EngineRunOutcome()
        return EngineRunOutcome(status, reason)


def _own_org_terms(owner: str) -> list[str]:
    """The person's own organisation and domains, from memory and their address."""
    from omnigent.memory.identity import own_org_terms

    return own_org_terms(owner)


async def _background_caller(owner: str) -> JudgeCaller | None:
    """The owner's Light model, as memory upkeep and titles call it."""
    from omnigent.memory.upkeep import resolve_upkeep_llm_caller

    return await resolve_upkeep_llm_caller(owner)
