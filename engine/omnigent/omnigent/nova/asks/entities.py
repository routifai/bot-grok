"""Domain types for what Nova needs from the person, durably.

An Ask is anything Nova is waiting on the person for: an approval, a
question with a few choices, a plan to accept, a skill to save, or a task
that is blocked until they weigh in. It shows up in "Waiting on you" and
must survive an Omnigent restart — unlike Omnigent's own in-process
elicitations (see ``bridge.py``), an Ask is a plain database row.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum


class AskKind(StrEnum):
    """What sort of thing Nova is waiting on.

    Mirrors the TypeScript prototype's ``AskKind`` (``muse-asks.ts``):
    ``approval`` for a yes/no gate, ``question`` for a free-standing choice,
    ``proposal`` for a plan awaiting accept/dismiss, ``blocked_task`` for a
    Goal task stuck on missing input, and ``skill_offer`` for a skill Nova
    wants to save.
    """

    APPROVAL = "approval"
    QUESTION = "question"
    PROPOSAL = "proposal"
    BLOCKED_TASK = "blocked_task"
    SKILL_OFFER = "skill_offer"


class AskStatus(StrEnum):
    """Lifecycle of an Ask."""

    OPEN = "open"
    ANSWERED = "answered"
    EXPIRED = "expired"


@dataclass(frozen=True)
class AskAction:
    """One tappable option offered on an Ask.

    :param id: Stable identifier the person's answer refers back to, e.g.
        ``"choice-1"`` or a semantic id like ``"accept"``.
    :param label: Short button text, e.g. ``"Use TypeScript"``.
    """

    id: str
    label: str


@dataclass(frozen=True)
class Ask:
    """One thing Nova is waiting on the person for.

    :param id: 32-char hex row id (see ``_shared.ids.new_id``).
    :param workspace_id: Tenant partition; ``0`` on single-workspace servers.
    :param user_id: The person this Ask is for.
    :param session_id: The Omnigent session the Ask concerns — the private
        conversation that raised it, or the Goal/task session it blocks.
        ``None`` for an Ask with no session of its own.
    :param kind: What sort of thing is being asked.
    :param text: The question or approval prompt, e.g. ``"Use TypeScript or
        Python for the scraper?"``.
    :param detail: Optional longer context shown under ``text``.
    :param actions: 0-4 tappable options; empty for a free-text question.
    :param status: Open, answered, or expired.
    :param answer: The person's answer (an action id, or free text), once
        answered; ``None`` while open.
    :param elicitation_id: The Omnigent elicitation this Ask mirrors, if it
        came from one — see ``bridge.py``. ``None`` for an Ask raised
        directly by a tool, or by Goals/Feed.
    :param goal_id: The Goal this Ask concerns, if any.
    :param task_id: The Goal task this Ask concerns, if any.
    :param created_at: Unix epoch seconds.
    :param answered_at: Unix epoch seconds the person answered, or ``None``
        while open.
    """

    id: str
    workspace_id: int
    user_id: str
    session_id: str | None
    kind: AskKind
    text: str
    detail: str | None
    actions: tuple[AskAction, ...]
    status: AskStatus
    answer: str | None
    elicitation_id: str | None
    goal_id: str | None
    task_id: str | None
    created_at: int
    answered_at: int | None
