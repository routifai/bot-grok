"""Plain-words schedule to RRULE: "every Monday at 9" becomes ``FREQ=WEEKLY;BYDAY=MO;...``.

Portions modified from getnao/nao apps/backend/src/services/cron-nlp.ts@5bde830, Apache-2.0;
changes: emits an RFC 5545 RRULE (what scheduled tasks store) instead of a 5-field cron, gives the
model the person's timezone and local clock, calls the server's own model layer
(:func:`omnigent.memory.upkeep.build_upkeep_llm_caller`) instead of a per-project provider, and
validates with :func:`~omnigent.server.scheduled.rrule.validate_rrule` so a rule the scheduler
would refuse (more often than hourly, never firing) is never returned.

One cheap few-shot model call, then validation. The model never sees the person's tasks.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime
from typing import Protocol
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from omnigent.server.scheduled.rrule import RRuleValidationError, validate_rrule

_logger = logging.getLogger(__name__)

MAX_TEXT_CHARS = 300

SCHEDULE_PROMPT = """\
Convert the user's plain-language schedule into one RFC 5545 recurrence rule (RRULE), \
evaluated in the person's own timezone. Output only the rule: one line, no "RRULE:" prefix, \
no DTSTART, UNTIL or COUNT, no commentary.

Always give the clock time as BYHOUR and BYMINUTE in 24-hour local time. When the person gives \
no minute, use 0; when they give an hour without am or pm ("at 9"), use the most natural \
working-day reading (7 to 11 is morning, 1 to 6 is afternoon). When they name no time for a \
daily, weekly or monthly rule, use 9:00. Weekdays are MO TU WE TH FR SA SU.

The shortest interval allowed is one hour. If the request is more frequent than hourly, is a \
one-off date, or is not a schedule at all, output exactly: NONE

Examples:
"every hour" -> FREQ=HOURLY
"every 2 hours" -> FREQ=HOURLY;INTERVAL=2
"every day at 8am" -> FREQ=DAILY;BYHOUR=8;BYMINUTE=0
"every Monday at 9" -> FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0
"weekdays at 6pm" -> FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=18;BYMINUTE=0
"Tuesdays and Thursdays at 14:30" -> FREQ=WEEKLY;BYDAY=TU,TH;BYHOUR=14;BYMINUTE=30
"every other Friday morning" -> FREQ=WEEKLY;INTERVAL=2;BYDAY=FR;BYHOUR=9;BYMINUTE=0
"first of every month" -> FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0
"last day of the month at 5pm" -> FREQ=MONTHLY;BYMONTHDAY=-1;BYHOUR=17;BYMINUTE=0
"every 5 minutes" -> NONE
"tomorrow at noon" -> NONE
"""

_FENCE = re.compile(r"^```[a-zA-Z]*\s*|\s*```$")


class ScheduleLLMCaller(Protocol):
    """One LLM call: a system prompt plus a user turn, returning raw text."""

    async def __call__(self, *, instructions: str, input_text: str) -> str: ...


def clean_rrule_answer(answer: str) -> str | None:
    """The RRULE in a model *answer*, or ``None`` for ``NONE`` or an empty answer.

    Tolerates a code fence, quotes, an ``RRULE:`` prefix and trailing commentary lines.
    """
    text = _FENCE.sub("", answer.strip()).strip()
    line = next((ln.strip() for ln in text.splitlines() if ln.strip()), "")
    line = line.strip("`\"' ")
    line = re.sub(r"^RRULE:\s*", "", line, flags=re.IGNORECASE).rstrip(".;")
    if not line or line.upper() == "NONE" or "FREQ=" not in line.upper():
        return None
    return line.upper()


async def natural_language_to_rrule(
    text: str,
    *,
    timezone: str = "UTC",
    llm_caller: ScheduleLLMCaller | None,
    now: datetime | None = None,
) -> str | None:
    """
    Turn a plain-words schedule into a validated RRULE.

    :param text: What the person said, e.g. ``"every Monday at 9"``.
    :param timezone: The person's IANA timezone; the rule fires in it, and the model is told
        their local date and time so relative words resolve correctly.
    :param llm_caller: The cheap-model caller (``build_upkeep_llm_caller()``), or ``None`` when
        no model is configured.
    :param now: Override for the current instant (tests).
    :returns: The RRULE, or ``None`` when no model is configured, the model could not read it
        as a recurring schedule, or the rule would be refused by the scheduler.
    """
    text = " ".join(text.split())[:MAX_TEXT_CHARS]
    if not text or llm_caller is None:
        return None
    try:
        zone = ZoneInfo(timezone)
    except (ZoneInfoNotFoundError, ValueError):
        zone = ZoneInfo("UTC")
        timezone = "UTC"
    local_now = (now or datetime.now(ZoneInfo("UTC"))).astimezone(zone)
    clock = f"The person's timezone is {timezone}; it is {local_now:%A %Y-%m-%d %H:%M} there."
    try:
        answer = await llm_caller(
            instructions=f"{SCHEDULE_PROMPT}\n{clock}", input_text=f"Schedule: {text}"
        )
    except Exception:  # noqa: BLE001 - a model outage must degrade to "could not read it"
        _logger.warning("schedule parsing call failed", exc_info=True)
        return None
    rule = clean_rrule_answer(answer)
    if rule is None:
        return None
    try:
        validate_rrule(rule)
    except RRuleValidationError:
        return None
    return rule
