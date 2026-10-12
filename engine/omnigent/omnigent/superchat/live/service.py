"""The live artifact operations the routes call (blocking: run them in a thread).

One module owns every change to a live row and to its scheduled task, so the routes and the
Super Chat tools share the same logic.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from typing import Any

from omnigent.db.utils import now_epoch
from omnigent.errors import ErrorCode, OmnigentError
from omnigent.server.auth import RESERVED_USER_LOCAL
from omnigent.superchat.artifacts.patches import PatchError, SetText, apply_patches
from omnigent.superchat.artifacts.store import (
    HAND_ORIGINS,
    Artifact,
    SqlAlchemyArtifactStore,
    VersionConflictError,
)
from omnigent.superchat.live.logic import plan_changes
from omnigent.superchat.live.store import Live, SqlAlchemyLiveStore

#: The scheduled-task kind of a live artifact's update.
LIVE_TASK_KIND = "live_artifact"
#: A hand edit this recent holds the next update back: the person is still working on the page.
DEFER_SECONDS = 600
#: Runs in a row that find changes they cannot place before the schedule pauses.
MAX_MISSES = 2

STALE = "The page changed since you read it. Call live_update_context again and redo the update."


def task_prompt(name: str) -> str:
    """The fixed instruction a live artifact's scheduled run starts with."""
    return (
        f'Update the live page "{name}" from its sources.\n'
        f'1. Call live_update_context with name "{name}". If it says defer is true, stop at once '
        "and end with the Result: skipped, the person is editing.\n"
        "2. Read each source in the Computer: open a web page in the browser, read a file with "
        "code. Work out every number with code, never guess one. If there are no sources, infer "
        "them from the page and this chat and pass them as sources when you save.\n"
        "3. Compare what you found with the stored facts. If nothing changed, call "
        "live_update_checked with the facts. Otherwise call live_update_save with only the real "
        "changes (page element id, new text, source) and the facts.\n"
        "4. End with a one-line Result that follows the tell rule live_update_save returned."
    )


def _stale() -> OmnigentError:
    return OmnigentError(STALE, code=ErrorCode.ARTIFACT_STALE)


class LiveService:
    """Operations on live artifacts, over the artifact, live and scheduled-task stores."""

    def __init__(
        self,
        artifacts: SqlAlchemyArtifactStore,
        live: SqlAlchemyLiveStore,
        tasks: Any,
        conversations: Any,
        scheduler: Callable[[], Any | None],
    ) -> None:
        """
        :param tasks: The scheduled-task store.
        :param conversations: The conversation store (the parent's agent runs the Helper).
        :param scheduler: Returns the live scheduler, or ``None`` when it is not running.
        """
        self.artifacts = artifacts
        self.live = live
        self.tasks = tasks
        self.conversations = conversations
        self._scheduler = scheduler

    # ------------------------------------------------------------------ schedule

    def upsert(
        self,
        item: Artifact,
        *,
        rrule: str,
        timezone: str | None,
        sources: list[dict[str, str]] | None,
        tell: str | None,
        follow_publish: bool | None,
    ) -> Live:
        """Make the deliverable live (or change how): the row and its scheduled task."""
        owner = item.user_id
        live = self.live.get(item.parent_session_id, item.name)
        task = self.tasks.get(live.task_id) if live else None
        if timezone is None:
            prefs = self.tasks.get_owner_preferences(owner or RESERVED_USER_LOCAL)
            timezone = task.timezone if task else (prefs.timezone if prefs else "UTC")
        prompt = task_prompt(item.name)
        if task is None:
            parent = self.conversations.get_conversation(item.parent_session_id)
            if parent is None or parent.agent_id is None:
                raise OmnigentError("chat not found", code=ErrorCode.NOT_FOUND)
            task = self.tasks.create(
                scheduled_task_id=uuid.uuid4().hex,
                name=f"Keep {item.title or item.name} up to date",
                prompt=prompt,
                rrule=rrule,
                user_id=owner,
                agent_id=parent.agent_id,
                timezone=timezone,
                parent_session_id=item.parent_session_id,
                agent_type="worker",
                kind=LIVE_TASK_KIND,
            )
            scheduler = self._scheduler()
            if scheduler is not None:
                scheduler.add(task)
        else:
            task = self.tasks.update(
                task.id, rrule=rrule, timezone=timezone, prompt=prompt, state="active"
            )
            self._rearm(task)
        live = live or Live(item.parent_session_id, item.name, owner, task.id)
        live.task_id = task.id
        if sources is not None:
            live.sources = sources
        if tell is not None:
            live.tell = tell
        if follow_publish is not None:
            live.follow_publish = follow_publish
        if live.state["misses"]:  # a person who sets the schedule again wants it running
            live.state.update(misses=0, open_issue=None)
        self.live.save(live)
        return live

    def _rearm(self, task: Any) -> None:
        scheduler = self._scheduler()
        if task is not None and scheduler is not None:
            scheduler.update(task)

    def remove(self, item: Artifact) -> bool:
        """Stop updating: delete the task and the row (versions stay). ``False`` if not live."""
        live = self.live.get(item.parent_session_id, item.name)
        if live is None:
            return False
        self.tasks.delete(live.task_id)
        scheduler = self._scheduler()
        if scheduler is not None:
            scheduler.remove(live.task_id)
        self.live.delete(item.parent_session_id, item.name)
        return True

    def defer_until(self, task: Any) -> float | None:
        """When a hand edit stops holding the task's run back (the fire path's hook)."""
        live = self.live.by_task(task.id)
        if live is None:
            return None
        group = self.artifacts.versions_of(
            user_id=live.user_id, parent_session_id=live.parent_session_id, name=live.name
        )
        return self._defer_end(group[0]) if group else None

    @staticmethod
    def _defer_end(head: Artifact) -> float | None:
        if head.origin in HAND_ORIGINS:
            end = head.created_at + DEFER_SECONDS
            return end if end > now_epoch() else None
        return None

    # ------------------------------------------------------------------ the Helper's side

    def head(self, item: Artifact) -> Artifact:
        """The newest version of the deliverable."""
        head = self.artifacts.newest(item)
        if head is None:
            raise OmnigentError("Artifact not found", code=ErrorCode.NOT_FOUND)
        return head

    def need_live(self, item: Artifact) -> Live:
        """The live row, or a 404 when the deliverable is not live."""
        live = self.live.get(item.parent_session_id, item.name)
        if live is None:
            raise OmnigentError("That page is not kept updated", code=ErrorCode.NOT_FOUND)
        return live

    def context(self, item: Artifact) -> dict[str, Any]:
        """What a run needs before it looks at the sources."""
        live = self.need_live(item)
        head = self.head(item)
        return {
            "sources": live.sources,
            "facts": live.state["facts"],
            "rejected": live.state["rejected"],
            "written": live.state["written"],
            "version": head.version,
            "defer": self._defer_end(head) is not None,
            "source": self.artifacts.read(head).decode("utf-8", "replace"),
        }

    def checked(self, item: Artifact, facts: dict[str, Any]) -> dict[str, Any]:
        """A run that found nothing new: only ``checked_at`` and the facts move."""
        live = self.need_live(item)
        live.state.update(facts=facts, checked_at=now_epoch())
        self.live.save(live)
        return {"version": None, "applied": [], "suggestions": [], "tell": live.tell}

    def save(
        self,
        item: Artifact,
        *,
        base_version: int,
        changes: list[dict[str, Any]],
        facts: dict[str, Any],
        sources: list[dict[str, str]] | None,
    ) -> dict[str, Any]:
        """Apply a run's changes to the newest version as one ``update`` version."""
        live = self.need_live(item)
        head = self.head(item)
        if head.version != base_version:
            raise _stale()
        state = live.state
        plan = plan_changes(self.artifacts.read(head), changes, state)
        now = now_epoch()
        created = None
        if plan.applied:
            created = self._create(
                head,
                plan.data,
                f"{len(plan.applied)} change{'' if len(plan.applied) == 1 else 's'}",
                "update",
            )
        kept = (state["last_update"] or {}).get("suggestions", [])
        gone = {s["id"] for s in plan.suggestions} | {a["id"] for a in plan.applied}
        suggestions = [s for s in kept if s["id"] not in gone] + plan.suggestions
        if created is not None:
            state["last_update"] = {
                "version": created.version,
                "applied": plan.applied,
                "suggestions": suggestions,
                "at": now,
            }
            state.update(open_issue=None, misses=0)
            self._follow(live, created)
        else:
            last = state["last_update"] or {"version": None, "applied": [], "at": now}
            state["last_update"] = {**last, "suggestions": suggestions}
            if plan.unplaced and not plan.suggestions and not plan.removed:
                state["misses"] += 1
                state["open_issue"] = "Could not place these changes on the page: " + ", ".join(
                    plan.unplaced
                )
                if state["misses"] >= MAX_MISSES:
                    self._pause(live)
        state.update(written=plan.written, rejected=plan.rejected, facts=facts, checked_at=now)
        if sources is not None:
            live.sources = sources
        self.live.save(live)
        return {
            "version": created.version if created else None,
            "applied": plan.applied,
            "suggestions": plan.suggestions,
            "unplaced": plan.unplaced,
            "removed": plan.removed,
            "tell": live.tell,
        }

    def _pause(self, live: Live) -> None:
        self._rearm(self.tasks.update(live.task_id, state="paused"))

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
        """Republish the new version when the page's published copy follows updates."""
        pub = self.artifacts.publication_for(created)
        if live.follow_publish and pub is not None:
            self.artifacts.publish(created, audience=pub.audience, version=created.version)

    # ------------------------------------------------------------------ the person's side

    def undo(self, item: Artifact) -> Artifact:
        """Restore the version before the last update and reject what it wrote."""
        live = self.need_live(item)
        head = self.head(item)
        last = live.state["last_update"]
        if not last or last["version"] != head.version or head.origin != "update":
            raise OmnigentError("Only the newest update can be undone", code=ErrorCode.CONFLICT)
        previous = next(
            (v for v in self.artifacts.versions(head) if v.id == head.parent_version_id), None
        )
        if previous is None:
            raise OmnigentError("Version not found", code=ErrorCode.NOT_FOUND)
        created = self._create(
            head, self.artifacts.read(previous), "undid the last update", "restore"
        )
        for change in last["applied"]:
            live.state["rejected"].append([change["id"], change["after"]])
            live.state["written"].pop(change["id"], None)
        last["applied"] = []
        self.live.save(live)
        self._follow(live, created)
        return created

    def accept(self, item: Artifact, element_id: str) -> Artifact:
        """Take the source's value for a part the person had changed."""
        live = self.need_live(item)
        head = self.head(item)
        last = live.state["last_update"] or {}
        suggestion = next((s for s in last.get("suggestions", []) if s["id"] == element_id), None)
        if suggestion is None:
            raise OmnigentError("No such suggestion", code=ErrorCode.NOT_FOUND)
        try:
            data, _ = apply_patches(
                self.artifacts.read(head),
                [SetText(kind="set-text", id=element_id, text=suggestion["source_value"])],
            )
        except PatchError as exc:
            raise OmnigentError(str(exc), code=ErrorCode.CONFLICT) from exc
        created = self._create(head, data, "took the source's value", "update")
        live.state["written"][element_id] = suggestion["source_value"]
        live.state["rejected"] = [r for r in live.state["rejected"] if r[0] != element_id]
        live.state["last_update"] = {
            "version": created.version,
            "applied": [
                {
                    "id": element_id,
                    "before": suggestion["yours"],
                    "after": suggestion["source_value"],
                    "source": suggestion.get("source"),
                    "notable": False,
                }
            ],
            "suggestions": [s for s in last["suggestions"] if s["id"] != element_id],
            "at": now_epoch(),
        }
        self.live.save(live)
        self._follow(live, created)
        return created
