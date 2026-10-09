"""Teach a task: record the person on the Computer, then distill the recording into a draft skill.

Recording runs through the sandbox provider's recording capability; stopping stores the trace and
keyframes on the server (never in the Computer) and starts a ``teacher`` Helper that writes the
draft with ``skill_draft_save``. Its Result does not wake the Conversation: the draft is read from
the skill row.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import uuid
from typing import Any

from omnigent.entities.taught_skill import ComputerRecording, TaughtSkill
from omnigent.onboarding.sandboxes.recording import RecordingMixin
from omnigent.server.scheduled.fire import FireDeps
from omnigent.server.scheduled.helper_fire import start_adhoc_helper
from omnigent.superchat.taught_skills.doc import build_brief, pick_brief_keyframes
from omnigent.superchat.taught_skills.store import SqlAlchemyTaughtSkillStore

_logger = logging.getLogger(__name__)

TEACHER_AGENT_TYPE = "teacher"
# A draft that has not arrived after this long is treated as failed.
DRAFTING_TIMEOUT_S = 600

_BACKGROUND: set[asyncio.Task[None]] = set()


def new_id() -> str:
    """A bare 32-char hex id."""
    return uuid.uuid4().hex


def recording_launcher(launcher: Any) -> RecordingMixin | None:
    """The launcher when it can record, else ``None``."""
    if isinstance(launcher, RecordingMixin) and launcher.capabilities.recording:
        return launcher
    return None


def build_distill_content(
    store: SqlAlchemyTaughtSkillStore, skill: TaughtSkill, recording: ComputerRecording
) -> list[dict[str, Any]]:
    """The teacher Helper's first message: the Brief plus a few keyframes as images."""
    content: list[dict[str, Any]] = [
        {"type": "input_text", "text": build_brief(skill.id, skill.goal, recording.actions)}
    ]
    for name in pick_brief_keyframes(recording.actions):
        jpeg = store.keyframe(recording.id, name)
        if not jpeg:
            continue
        content.append({"type": "input_text", "text": f"Frame {name}:"})
        uri = "data:image/jpeg;base64," + base64.b64encode(jpeg).decode("ascii")
        content.append({"type": "input_image", "image_url": uri})
    return content


async def distill(
    store: SqlAlchemyTaughtSkillStore,
    deps: FireDeps,
    skill: TaughtSkill,
    recording: ComputerRecording,
) -> None:
    """Start the teacher Helper for a stopped recording; a launch failure fails the skill."""
    try:
        content = await asyncio.to_thread(build_distill_content, store, skill, recording)
        await start_adhoc_helper(
            deps,
            parent_session_id=skill.parent_session_id,
            agent_type=TEACHER_AGENT_TYPE,
            name=f"Learn: {skill.goal[:60]}",
            user_id=skill.user_id,
            content=content,
        )
    except Exception:
        _logger.exception("teach: could not start the teacher for skill %s", skill.id)
        await asyncio.to_thread(store.set_status, skill.id, user_id=skill.user_id, status="failed")


def distill_in_background(
    store: SqlAlchemyTaughtSkillStore,
    deps: FireDeps,
    skill: TaughtSkill,
    recording: ComputerRecording,
) -> None:
    """Run :func:`distill` without holding up the stop request."""
    task = asyncio.create_task(distill(store, deps, skill, recording))
    _BACKGROUND.add(task)
    task.add_done_callback(_BACKGROUND.discard)


def expire_stale_draft(
    store: SqlAlchemyTaughtSkillStore, skill: TaughtSkill, now: int
) -> TaughtSkill:
    """A skill still ``drafting`` long after the recording stopped becomes ``failed``."""
    if (
        skill.status == "drafting"
        and skill.stopped_at is not None
        and now - skill.stopped_at > DRAFTING_TIMEOUT_S
    ):
        failed = store.set_status(skill.id, user_id=skill.user_id, status="failed")
        return failed or skill
    return skill
