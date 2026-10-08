"""Standing proactive run for a Super Chat: a daily Study.

When enabled (``OMNIGENT_PROACTIVE_PROVISION=1``) the server makes sure every
top-level superside-chat session has a Helper-bound scheduled task
(``docs/AUTOMATIONS.md`` "Helper-bound tasks"), on the user's next message:

* **Study** — daily 07:00 local, ``analyst``: reads the Memory Profile and the
  recent conversation, records 1-3 Ideas with ``suggestion_create``, and ends
  with a one-block JSON Result.

There is no scheduled Check-in any more (the Muse messages first only for real events). A
"Check-in" task left over on an existing chat is deleted the next time the chat is provisioned.

The task is reconciled to the owner's proactivity level (``/v1/me/proactivity``):
``off`` pauses it, ``low`` makes the Study weekly, ``normal`` keeps it daily. ``high`` has no
distinct behaviour yet and behaves like ``normal`` (the level exists so a client can store it).
Provisioning is idempotent (tasks are keyed by name under the parent) and goes
through the ordinary ``/v1/scheduled-tasks`` routes, so validation, ownership
and the live scheduler are the usual ones. Products opt in via the env flag.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

import httpx

_logger = logging.getLogger(__name__)

PROACTIVE_PROVISION_ENV = "OMNIGENT_PROACTIVE_PROVISION"
# Retired Type name kept as the Study task identity (existing rows, Activity titles); it runs as
# a fast ``worker`` (superchat.subagents.resolve_scheduled_helper).
AGENT_TYPE = "analyst"
STUDY_NAME = "Study"
# Standing tasks provisioned by an earlier version; deleted from existing chats.
CHECKIN_NAME = "Check-in"
RETIRED_NAMES = (CHECKIN_NAME,)
_RETRY_AFTER_FAILURE_S = 600.0

STUDY_PROMPT = """\
This is the person's daily study. You prepare; you do not act, and the person is not here, so \
never ask questions. Your job is a short list of Ideas worth their time, not a long one.

1. Learn who they are and what is going on. Read the Memory Profile you were given, then use \
`memory_search` (several queries) for their role, goals, projects, deadlines, decisions and the \
topics they follow. Read the person's conversation: `session_history` with \
`action: "list_chats"` gives its id, then `read` (the latest turns) and `search` it with that \
`chat_id` for anything left open, unanswered or newly important.
2. Learn what already exists, so you never duplicate it. Call `sys_scheduled_task_list`: every \
report, topic they follow and standing task is already covered, so an Idea that repeats one \
(even reworded, even "a weekly summary of X" when X is already followed) is wrong. Call \
`suggestion_list`: never repeat or rephrase an Idea that is waiting, was accepted or was \
dismissed.
3. Think like a sharp chief of staff for this person's role and current focus. Find 2 or 3 \
Ideas, each a concrete deliverable the assistant can produce alone: a comparison table, a \
briefing, a decision memo, a draft, a risk list, a one-page plan, a prepared question list. Each \
needs a clear reason it matters now: a deadline, something they said this week, a decision they \
face, a gap in what they have. Name real specifics from their world (their product, the \
competitors or documents they mentioned), never generic advice or "stay on top of X".
4. Quality bar: if you cannot tie an Idea to something the person said or is doing, drop it. \
Fewer is better than weak. If nothing clears the bar, record none and say so in the Result.
5. Record each with `suggestion_create`: `title` (at most 8 words, names the deliverable), `why` \
(one line: what in their world makes it timely), `message` (the exact first-person message the \
person would send to ask for it: states the deliverable, scope, format and any constraint they \
gave; specific enough to act on without follow-up questions).
6. Finish with the Result: exactly one fenced JSON block and nothing after it:
```json
{"kind": "study", "ideas_created": 0, "worth_telling": ""}
```
`ideas_created` is how many you recorded. `worth_telling` is one plain sentence for the person \
only if something is time-sensitive or notable, otherwise an empty string.
"""


@dataclass(frozen=True)
class ProactiveTaskSpec:
    """One standing task: its key name, schedule, prompt and whether it should run."""

    name: str
    rrule: str
    prompt: str
    active: bool


def desired_tasks(proactivity: str) -> list[ProactiveTaskSpec]:
    """The standing tasks for a proactivity level (``high`` behaves like ``normal`` for now)."""
    on = proactivity != "off"
    study_rrule = (
        "FREQ=WEEKLY;BYDAY=MO;BYHOUR=7;BYMINUTE=0"
        if proactivity == "low"
        else "FREQ=DAILY;BYHOUR=7;BYMINUTE=0"
    )
    return [ProactiveTaskSpec(STUDY_NAME, study_rrule, STUDY_PROMPT, on)]


def provisioning_enabled(env: Mapping[str, str] | None = None) -> bool:
    """Whether this deployment auto-provisions the standing runs."""
    raw = (env if env is not None else os.environ).get(PROACTIVE_PROVISION_ENV, "")
    return raw.strip().lower() in {"1", "true", "yes", "on"}


_DROPPED_HEADERS = frozenset({"content-length", "content-type", "host", "connection"})


class ProactiveProvisioner:
    """Reconciles a session's standing tasks, at most once per (level, timezone)."""

    def __init__(self, app: Any) -> None:
        self._app = app
        self._done: dict[str, tuple[str, str]] = {}
        self._failed_until: dict[str, float] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    async def _call(
        self, headers: Mapping[str, str], method: str, path: str, body: dict[str, Any] | None
    ) -> httpx.Response:
        forwarded = {k: v for k, v in headers.items() if k.lower() not in _DROPPED_HEADERS}
        transport = httpx.ASGITransport(app=self._app)
        async with httpx.AsyncClient(transport=transport, base_url="http://internal/v1") as client:
            return await client.request(method, path, json=body, headers=forwarded)

    async def ensure(self, session_id: str, headers: Mapping[str, str]) -> bool:
        """Create or reconcile the session's standing tasks; ``True`` when in sync."""
        if time.monotonic() < self._failed_until.get(session_id, 0.0):
            return False
        lock = self._locks.setdefault(session_id, asyncio.Lock())
        async with lock:
            try:
                return await self._ensure_locked(session_id, headers)
            except Exception:
                _logger.exception("proactive provisioning failed for %s", session_id)
                self._failed_until[session_id] = time.monotonic() + _RETRY_AFTER_FAILURE_S
                return False

    async def _ensure_locked(self, session_id: str, headers: Mapping[str, str]) -> bool:
        prefs = await self._call(headers, "GET", "/me/proactivity", None)
        prefs.raise_for_status()
        level = str(prefs.json().get("proactivity", "normal"))
        timezone = str(prefs.json().get("timezone") or "UTC")
        key = (level, timezone)
        if self._done.get(session_id) == key:
            return True
        listed = await self._call(
            headers, "GET", f"/scheduled-tasks?parent_session_id={session_id}", None
        )
        listed.raise_for_status()
        existing = {t["name"]: t for t in listed.json().get("scheduled_tasks", [])}
        for name in RETIRED_NAMES:
            retired = existing.get(name)
            if retired is not None:
                gone = await self._call(
                    headers, "DELETE", f"/scheduled-tasks/{retired['id']}", None
                )
                if gone.status_code not in (200, 204, 404):
                    gone.raise_for_status()
        for spec in desired_tasks(level):
            task = existing.get(spec.name)
            state = "active" if spec.active else "paused"
            if task is None:
                if not spec.active:
                    continue
                created = await self._call(
                    headers,
                    "POST",
                    "/scheduled-tasks",
                    {
                        "name": spec.name,
                        "prompt": spec.prompt,
                        "rrule": spec.rrule,
                        "timezone": timezone,
                        "parent_session_id": session_id,
                        "agent_type": AGENT_TYPE,
                    },
                )
                created.raise_for_status()
                continue
            patch = {
                field: want
                for field, want in (
                    ("prompt", spec.prompt),
                    ("rrule", spec.rrule),
                    ("timezone", timezone),
                    ("state", state),
                )
                if task.get(field) != want
            }
            if patch:
                updated = await self._call(
                    headers, "PATCH", f"/scheduled-tasks/{task['id']}", patch
                )
                updated.raise_for_status()
        self._done[session_id] = key
        return True
