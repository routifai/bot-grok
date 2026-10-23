"""The person's daily brief: its scheduled task, the run's opening message, the latest page.

Blocking: callers run it in a thread. One scheduled task per person and Conversation, kind
:data:`BRIEF_KIND`, made on first use with weekdays at 7:30 in the person's time zone; the person
pauses it or changes it in Automations like any other (ADR 0037).
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from omnigent.server.auth import RESERVED_USER_LOCAL
from omnigent.superchat.brief import sources
from omnigent.superchat.brief.page import BRIEF_NAME, page_line
from omnigent.superchat.brief.prompt import build_brief
from omnigent.superchat.brief.task import (
    BRIEF_AGENT_TYPE,
    BRIEF_KIND,
    BRIEF_MODEL,
    BRIEF_PROMPT,
    BRIEF_RRULE,
    BRIEF_TASK_NAME,
    brief_task_id,
)

_logger = logging.getLogger(__name__)

#: How far back the "yesterday" note may be (a Monday reads Friday's).
_PREVIOUS_NOTE_DAYS = 4


def _zone(name: str | None) -> ZoneInfo:
    try:
        return ZoneInfo(name) if name else ZoneInfo("UTC")
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo("UTC")


class BriefService:
    """Every read and write of the brief's task and page."""

    def __init__(
        self,
        tasks: Any,
        artifacts: Any,
        *,
        notes: Callable[[], Any | None],
        memory: Callable[[], Any | None],
    ) -> None:
        """
        :param tasks: The scheduled task store (also the owner preferences).
        :param artifacts: The artifact store the page's versions live in.
        :param notes: Returns the daily note store, or ``None`` when it is not installed.
        :param memory: Returns the memory service, or ``None`` when memory is off.
        """
        self.tasks = tasks
        self.artifacts = artifacts
        self._notes = notes
        self._memory = memory

    def _prefs_tz(self, owner: str) -> str | None:
        prefs = self.tasks.get_owner_preferences(owner)
        return prefs.timezone if prefs is not None else None

    def find(self, conversation_id: str) -> Any | None:
        """The Conversation's brief task, or ``None`` before its first use."""
        task = self.tasks.get(brief_task_id(conversation_id))
        return task if task is not None and task.kind == BRIEF_KIND else None

    def ensure(self, conversation: Any, user_id: str | None) -> tuple[Any, bool]:
        """The Conversation's brief task, made when missing; its time zone follows the person's.

        :param conversation: The person's Conversation (the task's parent).
        :param user_id: The owner (``None`` in single-user mode).
        :returns: ``(task, changed)``; ``changed`` when it was made or its zone moved, so the
            caller re-arms the scheduler.
        """
        timezone = self._prefs_tz(user_id or RESERVED_USER_LOCAL)
        task = self.find(conversation.id)
        if task is not None:
            if timezone and task.timezone != timezone:
                return self.tasks.update(task.id, timezone=timezone) or task, True
            return task, False
        try:
            task = self.tasks.create(
                scheduled_task_id=brief_task_id(conversation.id),
                name=BRIEF_TASK_NAME,
                prompt=BRIEF_PROMPT,
                rrule=BRIEF_RRULE,
                user_id=user_id,
                agent_id=conversation.agent_id,
                timezone=timezone or "UTC",
                parent_session_id=conversation.id,
                agent_type=BRIEF_AGENT_TYPE,
                kind=BRIEF_KIND,
                model_override=BRIEF_MODEL,
            )
        except Exception:
            # A concurrent first use made it: the derived id makes the second insert fail.
            task = self.find(conversation.id)
            if task is None:
                raise
            return task, False
        return task, True

    def run_brief(self, task: Any) -> str:
        """The fire path's hook: the run's opening message, read now (ADR 0037)."""
        owner = task.user_id or RESERVED_USER_LOCAL
        today = datetime.now(UTC).astimezone(_zone(self._prefs_tz(owner) or task.timezone)).date()
        previous, today_note = self._notes_around(owner, today)
        try:
            topics = sources.open_topics(owner)
        except Exception:
            _logger.exception("brief: could not read the topics of %s", owner)
            topics = None
        try:
            connectors = sources.connected_sources(owner)
        except Exception:
            _logger.exception("brief: could not read the connected sources of %s", owner)
            connectors = []
        return build_brief(
            today=today,
            previous=previous,
            today_note=today_note,
            topics=topics,
            connectors=connectors,
            memory=self._standing_memory(owner),
        )

    def _notes_around(
        self, owner: str, today: date
    ) -> tuple[tuple[str, dict[str, str]] | None, dict[str, str] | None]:
        """``((date, sections) of the last note before today, today's sections)``."""
        store = self._notes()
        if store is None:
            return None, None
        try:
            earlier = store.list_range(
                owner,
                date_from=(today - timedelta(days=_PREVIOUS_NOTE_DAYS)).isoformat(),
                date_to=(today - timedelta(days=1)).isoformat(),
                limit=1,
            )
            note = store.get(owner, today.isoformat())
        except Exception:
            _logger.exception("brief: could not read the notes of %s", owner)
            return None, None
        previous = (earlier[0].note_date, earlier[0].sections) if earlier else None
        return previous, note.sections if note is not None else None

    def _standing_memory(self, owner: str) -> str | None:
        service = self._memory()
        if service is None:
            return None
        try:
            return service.profile(owner)
        except Exception:
            _logger.exception("brief: could not read the standing memory of %s", owner)
            return None

    def latest(self, task: Any, artifact_owner: str | None) -> dict[str, Any] | None:
        """The newest brief page: ``{artifact_id, group_id, title, version, created_at, line}``."""
        versions = self.artifacts.versions_of(
            user_id=artifact_owner, parent_session_id=task.parent_session_id, name=BRIEF_NAME
        )
        if not versions:
            return None
        head = versions[0]
        try:
            line = page_line(self.artifacts.read(head))
        except Exception:
            _logger.exception("brief: could not read page %s", head.id)
            line = None
        return {
            "artifact_id": head.id,
            "group_id": head.group_id or head.id,
            "title": head.title,
            "version": head.version,
            "created_at": head.created_at,
            "line": line,
        }
