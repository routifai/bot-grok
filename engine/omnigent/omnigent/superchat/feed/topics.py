"""What a followed topic is, what a post is, and when a post has ``nothing_new`` (pure).

* **Followed topic.** A scheduled task bound to a parent session whose ``kind`` is
  :data:`FOLLOWED_TOPIC_KIND`. The Muse sets it when it creates the task
  (``sys_scheduled_task_create`` ``kind``). Tasks created before the marker existed have no
  ``kind``; for those only, a ``worker`` Helper task still counts (the old heuristic, kept as a
  read fallback).
* **Post.** The last assistant text of a finished run's session plus the cards it rendered.
* **nothing_new.** The worker's brief ends with "exactly ``Nothing new.`` when there is
  nothing" (``infra/omnigent/templates/AGENTS.md``). :func:`is_nothing_new` is the ONE place
  that reads that contract: a result whose whole text is those words (case, surrounding space
  and trailing punctuation ignored) and that has no cards has nothing new.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any

from omnigent.entities import ScheduledTask
from omnigent.superchat.transcript.blocks import project_items

FOLLOWED_TOPIC_KIND = "followed_topic"
_LEGACY_AGENT_TYPE = "worker"
_NOTHING_NEW = re.compile(r"^\W*nothing\s+new\W*$", re.IGNORECASE)
_CADENCES = {"HOURLY": "hourly", "DAILY": "daily", "WEEKLY": "weekly"}


def is_followed_topic(task: ScheduledTask) -> bool:
    """Whether *task* is a topic the Muse follows for the person."""
    if task.parent_session_id is None:
        return False
    if task.kind is not None:
        return task.kind == FOLLOWED_TOPIC_KIND
    return task.agent_type == _LEGACY_AGENT_TYPE


def cadence_of(rrule: str) -> str | None:
    """``hourly`` / ``daily`` / ``weekly`` from the RRULE frequency, else ``None``."""
    match = re.search(r"(?:^|;)FREQ=([A-Za-z]+)", rrule)
    return _CADENCES.get(match.group(1).upper()) if match else None


def is_nothing_new(text: str, cards: list[dict[str, Any]]) -> bool:
    """Whether a run's result says there is nothing to show (the single rule, see module doc)."""
    return not cards and bool(_NOTHING_NEW.match(text))


def topic_to_response(task: ScheduledTask) -> dict[str, Any]:
    """A followed topic as the API returns it."""
    return {
        "id": task.id,
        "name": task.name,
        "cadence": cadence_of(task.rrule),
        "rrule": task.rrule,
        "timezone": task.timezone,
        "state": task.state,
        "session_id": task.parent_session_id,
        "created_at": task.created_at,
    }


def post_from_items(
    items: list[Mapping[str, Any]], *, run_id: str, topic_id: str, session_id: str, created_at: int
) -> dict[str, Any] | None:
    """A post from a run session's items (oldest first), or ``None`` when it produced nothing."""
    messages = project_items(items)
    text = ""
    cards: list[dict[str, Any]] = []
    for message in messages:
        if message["role"] != "assistant":
            continue
        for block in message["blocks"]:
            if block.get("type") == "text":
                text = block["text"]
            elif block.get("type") == "card" and not block.get("pending"):
                cards.append(block)
    if not text and not cards:
        return None
    return {
        "id": run_id,
        "topic_id": topic_id,
        "run_id": run_id,
        "session_id": session_id,
        "created_at": created_at,
        "text": text,
        "cards": cards,
        "nothing_new": is_nothing_new(text, cards),
    }
