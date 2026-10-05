"""Per-turn work-step limit for the Conversation (and its side chats).

The Muse keeps every work tool but does single-step work itself; long work belongs to a Helper
so the chat stays responsive. Wording alone did not hold, so a turn may make
:func:`step_limit` work tool calls (search/fetch, browser, shell and files, artifact writes) and
the next one is refused with an instruction to hand the rest to a ``worker`` Helper. Memory,
cards, Goals, scheduling, vault and Helper management never count. Helpers are never limited.

A "turn" starts at each user message (the REQUEST phase resets the counter), which also covers
the runtime's own wake messages. The person saying "do it here" lifts the limit for that turn:
a small phrase check on their message, not a model-supplied flag the model could set itself.
"""

from __future__ import annotations

import os
import re
import time
from typing import Any

from omnigent.policies.schema import (
    PolicyEvent,
    PolicyResponse,
    request_is_system_notice,
    request_user_text,
)
from omnigent.superchat.feature import is_super_chat
from omnigent.superchat.work_tools import is_work_tool

POLICY_NAME = "__muse_step_limit"
STATE_KEY = "muse_step_limit"
LIMIT_ENV = "OMNIGENT_SUPERCHAT_STEP_LIMIT"
DEFAULT_LIMIT = 3

# A turn that never saw its REQUEST reset (the gate was skipped) must not lock the chat for
# good: a quiet gap this long counts as a new turn.
_STALE_SECONDS = 600

_OVERRIDE_RE = re.compile(
    r"\b(?:do|handle|run|finish|take care of)\s+(?:it|this|that|them|everything)\s+"
    r"(?:right\s+)?(?:here|yourself|directly|on your own)\b"
    r"|\b(?:don'?t|do\s+not|no\s+need\s+to|without)\s+(?:delegat\w*|(?:a\s+)?helpers?|"
    r"(?:a\s+)?workers?|hand(?:ing)?\s+(?:it\s+)?off)\b"
    r"|\b(?:stay|keep\s+(?:at\s+)?it)\s+(?:right\s+)?here\b"
    r"|\b(?:do|handle|run|finish)\b[^.?!]{0,30}\byourself\b",
    re.IGNORECASE,
)

REFUSAL = (
    "Work-step limit reached for this turn. Hand the rest of this task to a Helper now: call "
    "`start_helper` once with a task saying what the person wants and everything found so far, "
    "then tell the person in one plain line what you started (never mention Helpers or tools) "
    "and end your turn. Do not call more work tools yourself."
)


def step_limit(env: dict[str, str] | None = None) -> int:
    """The configured limit; ``0`` (or less) turns the limit off.

    :param env: Environment mapping, ``os.environ`` when ``None``.
    :returns: The number of work calls allowed per turn.
    """
    raw = (env if env is not None else os.environ).get(LIMIT_ENV)
    if raw is None:
        return DEFAULT_LIMIT
    try:
        return int(raw)
    except ValueError:
        return DEFAULT_LIMIT


def asks_to_do_it_here(text: str) -> bool:
    """Whether the person asked the Muse to do the work itself rather than delegate."""
    return bool(_OVERRIDE_RE.search(text))


def _set(state: dict[str, Any]) -> list[dict[str, Any]]:
    return [{"key": STATE_KEY, "action": "set", "value": state}]


def muse_step_limit(event: PolicyEvent) -> PolicyResponse | None:
    """Count work tool calls in a Conversation turn and refuse the one past the limit.

    :param event: Policy event; ``request`` resets the turn, ``tool_call`` counts.
    :returns: A DENY with the hand-off instruction past the limit, a counter update, or ``None``.
    """
    context = event.get("context") or {}
    labels = context.get("labels") if isinstance(context, dict) else None
    if not is_super_chat(labels if isinstance(labels, dict) else None):
        return None
    now = time.time()
    kind = event.get("type")
    if kind == "request":
        text = request_user_text(event.get("data"))
        free = not request_is_system_notice(event.get("data")) and asks_to_do_it_here(text)
        return {
            "result": "ALLOW",
            "state_updates": _set({"n": 0, "free": free, "ts": now}),
        }
    if kind != "tool_call":
        return None
    data = event.get("data")
    name = data.get("name") if isinstance(data, dict) else None
    limit = step_limit()
    if not isinstance(name, str) or not is_work_tool(name) or limit <= 0:
        return None
    raw = (event.get("session_state") or {}).get(STATE_KEY)
    state = raw if isinstance(raw, dict) else {}
    if now - float(state.get("ts", 0) or 0) > _STALE_SECONDS:
        state = {}
    if state.get("free"):
        return None
    count = int(state.get("n", 0) or 0)
    if count >= limit:
        return {"result": "DENY", "reason": REFUSAL}
    return {
        "result": "ALLOW",
        "state_updates": _set({"n": count + 1, "free": False, "ts": now}),
    }
