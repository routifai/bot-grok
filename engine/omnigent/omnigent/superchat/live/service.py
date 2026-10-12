"""Live artifact operations over the artifact, live and scheduled-task stores.

Blocking: callers run them in a thread. Rules: ``docs/live-artifacts.md``.
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Callable
from typing import Any

from omnigent.db.utils import now_epoch
from omnigent.errors import ErrorCode, OmnigentError
from omnigent.server.auth import RESERVED_USER_LOCAL
from omnigent.superchat.artifacts.store import (
    HAND_ORIGINS,
    Artifact,
    SqlAlchemyArtifactStore,
    VersionConflictError,
)
from omnigent.superchat.live.logic import Plan, plan_changes
from omnigent.superchat.live.store import Live, SqlAlchemyLiveStore

LIVE_TASK_KIND = "live_artifact"
#: A hand edit this recent holds the next run back: the person is still working on the page.
DEFER_SECONDS = 600
#: Runs in a row with changes they cannot place before the schedule pauses.
MAX_MISSES = 2


def task_prompt(name: str) -> str:
    """The fixed instruction a live artifact's scheduled run starts with."""
    return (
        f'Update the live page "{name}" from its sources.\n'
        f'1. Call live_update_context with name "{name}".\n'
        "2. Read each source in the Computer: open a web page in the browser, read a file with "
        "code. Work out every number with code, never guess one. If there are no sources, infer "
        "them from the page and this chat and pass them as sources when you save.\n"
        "3. Call live_update_save once with only the facts that differ from what the page shows "
        "(element id, new text, source) and the facts you read; no changes when nothing differs. "
        "If it says the page changed, start again at step 1.\n"
        "4. End with a one-line Result that follows the tell rule live_update_save returned and "
        "names each change as what it is, before → after ('Saffron chai $18.25 → $19.50').\n"
        "If you cannot finish, say why in the Result and add that the page stays as it is until "
        "the next run: the update is yours, nobody should redo it by hand or in chat."
    )


def _err(message: str, code: ErrorCode) -> OmnigentError:
    return OmnigentError(message, code=code)


class LiveService:
    """Every change to a live row and to its scheduled task."""

    def __init__(
        self,
        artifacts: SqlAlchemyArtifactStore,
        live: SqlAlchemyLiveStore,
        tasks: Any,
        conversations: Any,
        scheduler: Callable[[], Any | None],
    ) -> None:
        """``scheduler`` returns the running scheduler, or ``None``."""
        self.artifacts = artifacts
        self.live = live
        self.tasks = tasks
        self.conversations = conversations
        self._scheduler = scheduler

    #: The server's event loop, noted by the routes: the scheduler's timers live on it, and the
    #: service runs in worker threads.
    loop: asyncio.AbstractEventLoop | None = None

    def _on_scheduler(self, call: Callable[[Any], None]) -> None:
        """Run ``call(scheduler)`` on the event loop. Skipped without one: the fire path re-reads
        the task, so a stale timer never runs a paused or deleted task."""
        if (scheduler := self._scheduler()) is None or self.loop is None:
            return
        self.loop.call_soon_threadsafe(call, scheduler)

    def _sync(self, task: Any) -> None:
        self._on_scheduler(lambda scheduler: scheduler.update(task))

    def upsert(
        self,
        item: Artifact,
        *,
        rrule: str,
        sources: list[str] | None = None,
        tell: str | None = None,
        follow_publish: bool | None = None,
    ) -> Live:
        """Make the page live, or change its schedule; setting it again resumes a paused one."""
        live = self.live.get(item.parent_session_id, item.name)
        task = self.tasks.get(live.task_id) if live else None
        if task is None:
            parent = self.conversations.get_conversation(item.parent_session_id)
            if parent is None or parent.agent_id is None:
                raise _err("chat not found", ErrorCode.NOT_FOUND)
            prefs = self.tasks.get_owner_preferences(item.user_id or RESERVED_USER_LOCAL)
            task = self.tasks.create(
                scheduled_task_id=uuid.uuid4().hex,
                name=f"Keep {item.title or item.name} up to date",
                prompt=task_prompt(item.name),
                rrule=rrule,
                user_id=item.user_id,
                agent_id=parent.agent_id,
                timezone=(prefs and prefs.timezone) or "UTC",
                parent_session_id=item.parent_session_id,
                agent_type="worker",
                kind=LIVE_TASK_KIND,
            )
        else:
            task = self.tasks.update(
                task.id, rrule=rrule, state="active", prompt=task_prompt(item.name)
            )
        self._sync(task)
        live = live or Live(item.parent_session_id, item.name, item.user_id, task.id)
        live.task_id = task.id
        live.sources = live.sources if sources is None else sources
        live.tell = tell or live.tell
        live.follow_publish = live.follow_publish if follow_publish is None else follow_publish
        live.state.update(misses=0, open_issue=None)
        self.live.save(live)
        return live

    def remove(self, item: Artifact) -> bool:
        """Stop updating: the task and the row go, the versions stay. ``False`` if not live."""
        live = self.live.get(item.parent_session_id, item.name)
        if live is None:
            return False
        self.tasks.delete(live.task_id)
        task_id = live.task_id
        self._on_scheduler(lambda scheduler: scheduler.remove(task_id))
        self.live.delete(item.parent_session_id, item.name)
        return True

    def defer_until(self, task: Any) -> float | None:
        """The fire path's hook: a recent hand edit holds the run back until it is old enough."""
        live = self.live.by_task(task.id)
        if live is None:
            return None
        group = self.artifacts.versions_of(
            user_id=live.user_id, parent_session_id=live.parent_session_id, name=live.name
        )
        hand = group and group[0].origin in HAND_ORIGINS
        return group[0].created_at + DEFER_SECONDS if hand else None

    def need(self, item: Artifact) -> tuple[Live, Artifact]:
        """The live row and the newest version, or a 404 when the page is not live."""
        live = self.live.get(item.parent_session_id, item.name)
        head = self.artifacts.newest(item)
        if live is None or head is None:
            raise _err("That page is not kept updated", ErrorCode.NOT_FOUND)
        return live, head

    def context(self, item: Artifact) -> dict[str, Any]:
        """What a run needs before it reads the sources."""
        live, head = self.need(item)
        return {
            "sources": live.sources,
            "facts": live.state["facts"],
            "version": head.version,
            "source": self.artifacts.read(head).decode("utf-8", "replace"),
        }

    def save(
        self,
        item: Artifact,
        *,
        base_version: int,
        changes: list[dict[str, Any]],
        facts: dict[str, Any],
        sources: list[str] | None,
    ) -> dict[str, Any]:
        """A run's outcome: at most one ``update`` version; no change moves ``checked_at`` only."""
        live, head = self.need(item)
        if changes and head.version != base_version:
            raise _stale()
        plan, created = self._apply(live, head, changes)
        state = live.state
        state["misses"] = state["misses"] + 1 if plan.unplaced else 0
        state["open_issue"] = (
            "Could not place these changes on the page: " + ", ".join(plan.unplaced)
            if plan.unplaced
            else None
        )
        if state["misses"] >= MAX_MISSES:
            self._sync(self.tasks.update(live.task_id, state="paused"))
        state.update(facts=facts, checked_at=now_epoch())
        live.sources = live.sources if sources is None else sources
        self.live.save(live)
        return {
            "version": created.version if created else None,
            "applied": plan.applied,
            "suggestions": plan.suggestions,
            "unplaced": plan.unplaced,
            "removed": plan.removed,
            "declined": plan.declined,
            "tell": live.tell,
        }

    def undo(self, item: Artifact) -> Artifact:
        """Restore the version before the newest update and reject what that update wrote."""
        live, head = self.need(item)
        last = live.state["last_update"]
        if not last or last["version"] != head.version or head.origin != "update":
            raise _err("Only the newest update can be undone", ErrorCode.CONFLICT)
        previous = self.artifacts.get(head.parent_version_id or "", user_id=head.user_id)
        if previous is None:
            raise _err("Version not found", ErrorCode.NOT_FOUND)
        data = self.artifacts.read(previous)
        created = self._create(head, data, "undid the last update", "restore")
        for change in last["applied"]:
            live.state["rejected"].append([change["id"], change["after"]])
            live.state["written"].pop(change["id"], None)
        last["applied"] = []
        self.live.save(live)
        self._follow(live, created)
        return created

    def accept(self, item: Artifact, element_id: str) -> Artifact:
        """Take the source's value for a part the person changed; it follows the source again."""
        live, head = self.need(item)
        suggestions = (live.state["last_update"] or {}).get("suggestions", [])
        suggestion = next((s for s in suggestions if s["id"] == element_id), None)
        if suggestion is None:
            raise _err("No such suggestion", ErrorCode.NOT_FOUND)
        live.state["written"].pop(element_id, None)
        live.state["rejected"] = [r for r in live.state["rejected"] if r[0] != element_id]
        change = {**suggestion, "after": suggestion["source_value"]}
        _, created = self._apply(live, head, [change], "took the source's value")
        if created is None:
            raise _err("That part of the page can no longer be changed", ErrorCode.CONFLICT)
        self.live.save(live)
        return created

    def _apply(
        self, live: Live, head: Artifact, changes: list[dict[str, Any]], summary: str = ""
    ) -> tuple[Plan, Artifact | None]:
        """Plan ``changes`` on ``head``, store one version, update the state in memory."""
        state = live.state
        plan = plan_changes(self.artifacts.read(head), changes, state)
        created = None
        if plan.applied:
            count = len(plan.applied)
            summary = summary or f"{count} change{'' if count == 1 else 's'}"
            created = self._create(head, plan.data, summary, "update")
        kept = (state["last_update"] or {}).get("suggestions", [])
        touched = {c["id"] for c in plan.suggestions + plan.applied}
        suggestions = [s for s in kept if s["id"] not in touched] + plan.suggestions
        if created is not None:
            last = {"version": created.version, "applied": plan.applied, "at": now_epoch()}
            state["last_update"] = {**last, "suggestions": suggestions}
            self._follow(live, created)
        elif suggestions != kept:
            last = state["last_update"] or {"version": None, "applied": [], "at": now_epoch()}
            state["last_update"] = {**last, "suggestions": suggestions}
        state.update(written=plan.written, rejected=plan.rejected)
        return plan, created

    def _create(self, head: Artifact, data: bytes, summary: str, origin: str) -> Artifact:
        try:
            return self.artifacts.create(
                user_id=head.user_id,
                parent_session_id=head.parent_session_id,
                name=head.name,
                title=head.title,
                kind=head.kind,
                mime=head.mime,
                data=data,
                origin=origin,
                parent_version_id=head.id,
                source_path=head.source_path,
                edit_summary=summary,
                base_version=head.version,
            )
        except VersionConflictError as exc:
            raise _stale() from exc

    def _follow(self, live: Live, created: Artifact) -> None:
        """Republish (same audience) when the published copy follows updates."""
        pub = self.artifacts.publication_for(created)
        if live.follow_publish and pub is not None:
            self.artifacts.publish(created, audience=pub.audience, version=created.version)


def _stale() -> OmnigentError:
    return _err(
        "The page changed since you read it. Call live_update_context again and redo the update.",
        ErrorCode.ARTIFACT_STALE,
    )
