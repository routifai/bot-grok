"""The brief's scheduled task: its kind, its derived id and what it is made with (ADR 0037).

No imports beyond the standard library: the runner-side handler reads the id too.
"""

from __future__ import annotations

import uuid

#: The scheduled task's kind; 0036 labels its messages as the proactive kind ``brief``.
BRIEF_KIND = "daily_brief"
#: How ADR 0036 labels the run's message: ``proactive: {kind, urgency}``.
PROACTIVE_KIND = "brief"
PROACTIVE_URGENCY = "brief"
BRIEF_TASK_NAME = "Morning brief"
#: Weekdays at 7:30, in the task's time zone.
BRIEF_RRULE = "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=7;BYMINUTE=30"
#: The Helper Type a run uses: the general one, as a live page's update does.
BRIEF_AGENT_TYPE = "worker"
#: The model category of a run (ADR 0037: one Builder-model run per person per weekday).
BRIEF_MODEL = "builder"
#: What the task holds as its prompt; each run starts with :func:`build_brief` instead.
BRIEF_PROMPT = (
    "Write the person's morning brief with brief_save: what needs them today, their day, what "
    "moved since yesterday and what is worth knowing, from their notes, topics and memory."
)


def brief_task_id(conversation_id: str) -> str:
    """The task id for a Conversation's brief: derived, so two first uses make one row."""
    return uuid.uuid5(uuid.NAMESPACE_OID, f"omnigent-daily-brief\0{conversation_id}").hex
