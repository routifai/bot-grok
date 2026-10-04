"""Taught-skill entities: a recording of what a person did, and the skill drafted from it."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

RECORDING_STATUSES = ("recording", "stopped", "failed")
TAUGHT_SKILL_STATUSES = ("recording", "drafting", "draft", "saved", "failed")


@dataclass
class ComputerRecording:
    """
    One recording of a person using a session's computer.

    :param id: Bare 32-char hex id.
    :param user_id: Owner, or ``None`` in single-user mode.
    :param session_id: The session whose computer was recorded.
    :param goal: What the person said they were teaching.
    :param status: One of :data:`RECORDING_STATUSES`.
    :param actions: Ordered semantic actions once stopped (secret values never included).
    :param started_at: Epoch seconds.
    :param stopped_at: Epoch seconds, or ``None`` while recording.
    """

    id: str
    user_id: str | None
    session_id: str
    goal: str
    status: str
    started_at: int
    actions: list[dict[str, Any]] = field(default_factory=list)
    stopped_at: int | None = None


@dataclass
class TaughtSkill:
    """
    A skill taught by demonstration.

    :param id: Bare 32-char hex id.
    :param user_id: Owner, or ``None`` in single-user mode.
    :param parent_session_id: The session (Conversation) it belongs to.
    :param recording_id: The recording it was drafted from, or ``None``.
    :param name: Short name (from the document once drafted).
    :param goal: What the person said they were teaching.
    :param status: One of :data:`TAUGHT_SKILL_STATUSES`.
    :param doc: The current document (see ``omnigent.superchat.taught_skills.doc``), or ``None``
        before the first draft.
    :param version: Current version number; ``0`` before the first draft.
    :param created_at: Epoch seconds.
    :param updated_at: Epoch seconds of the last change, or ``None``.
    :param stopped_at: Epoch seconds the recording stopped, or ``None``.
    """

    id: str
    user_id: str | None
    parent_session_id: str
    recording_id: str | None
    name: str
    goal: str
    status: str
    doc: dict[str, Any] | None
    version: int
    created_at: int
    updated_at: int | None = None
    stopped_at: int | None = None
