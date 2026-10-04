"""Standing proactive runs for a Super Chat: a daily Study and a weekday Check-in.

When enabled (``OMNIGENT_PROACTIVE_PROVISION=1``) the server makes sure every
top-level superside-chat session has two Helper-bound scheduled tasks
(``docs/AUTOMATIONS.md`` "Helper-bound tasks"), on the user's next message:

* **Study** — daily 07:00 local, ``analyst``: reads the Memory Profile and the
  recent conversation, records 1-3 Ideas with ``suggestion_create``, and ends
  with a one-block JSON Result.
* **Check-in** — weekdays 16:00 local, ``analyst``: says ``Nothing new.`` unless
  something is pending.

The tasks are reconciled to the owner's proactivity level (``/v1/me/proactivity``):
``off`` pauses both, ``low`` keeps a weekly Study only, ``normal`` runs both.
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
AGENT_TYPE = "analyst"
STUDY_NAME = "Study"
CHECKIN_NAME = "Check-in"
_RETRY_AFTER_FAILURE_S = 600.0

STUDY_PROMPT = """\
This is the person's daily study. You prepare; you do not act, and the person is not here, so \
never ask questions.

1. Learn what is going on. Read the Memory Profile you were given, then use `memory_search` for \
their goals, projects, deadlines and the topics they follow. Read the person's conversation: \
`session_history` with `action: "list_chats"` gives its id, then `read` (the latest turns) and \
`search` it with that `chat_id` for anything left open or unanswered.
2. Call `suggestion_list` to see the Ideas already waiting. Never repeat or rephrase one.
3. Find 1 to 3 concrete things the assistant could do for the person next: research, a draft, a \
comparison, a plan, a summary, following a topic, or taking on a goal. Each must be grounded in \
something they said or are working on and be doable by the assistant alone. No generic \
productivity advice. If nothing is grounded, record fewer, or none.
4. Record each with `suggestion_create`: `title` (at most 8 words), `why` (one line naming what \
in their world prompts it), `message` (the exact first-person message the person would send to \
ask for it, specific enough to act on).
5. Finish with the Result: exactly one fenced JSON block and nothing after it:
```json
{"kind": "study", "ideas_created": 0, "worth_telling": ""}
```
`ideas_created` is how many you recorded. `worth_telling` is one plain sentence for the person \
only if something is time-sensitive or notable, otherwise an empty string.
"""

CHECKIN_PROMPT = """\
This is a quiet check-in for the person. You prepare; you do not act, and the person is not \
here, so never ask questions.

Look for anything that needs their attention now: goals still open and due or stalled, asks \
they made that were never answered, new findings on topics they follow. Use `memory_search`, \
`session_history` (`list_chats` for the conversation's id, then `read` it with that `chat_id`) \
and `suggestion_list`.

If nothing meaningful happened or is pending, reply with exactly: Nothing new.

Otherwise finish with the Result: exactly one fenced JSON block and nothing after it:
```json
{"kind": "check_in", "worth_telling": "one or two plain sentences for the person"}
```
"""


@dataclass(frozen=True)
class ProactiveTaskSpec:
    """One standing task: its key name, schedule, prompt and whether it should run."""

    name: str
    rrule: str
    prompt: str
    active: bool


def desired_tasks(proactivity: str) -> list[ProactiveTaskSpec]:
    """The standing tasks for a proactivity level (``off``/``low``/``normal``)."""
    on = proactivity != "off"
    study_rrule = (
        "FREQ=WEEKLY;BYDAY=MO;BYHOUR=7;BYMINUTE=0"
        if proactivity == "low"
        else "FREQ=DAILY;BYHOUR=7;BYMINUTE=0"
    )
    return [
        ProactiveTaskSpec(STUDY_NAME, study_rrule, STUDY_PROMPT, on),
        ProactiveTaskSpec(
            CHECKIN_NAME,
            "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=16;BYMINUTE=0",
            CHECKIN_PROMPT,
            proactivity == "normal",
        ),
    ]


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
