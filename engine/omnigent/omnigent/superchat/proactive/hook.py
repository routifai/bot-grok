"""The one call ``routes_events`` makes: provision standing proactive tasks on a user message."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from omnigent.stores.conversation_store import SIDE_CHAT_LABEL_KEY
from omnigent.superchat.feature import is_super_chat
from omnigent.superchat.proactive.provisioner import ProactiveProvisioner, provisioning_enabled

if TYPE_CHECKING:
    from fastapi import Request

    from omnigent.entities import Conversation

_PROACTIVE_TASKS: set[asyncio.Task[bool]] = set()


def is_proactive_super_chat(conv: Conversation) -> bool:
    """A top-level Super Chat (not a Side Chat or Helper) when provisioning is enabled."""
    labels = conv.labels or {}
    return (
        provisioning_enabled()
        and is_super_chat(labels)
        and SIDE_CHAT_LABEL_KEY not in labels
        and conv.parent_conversation_id is None
    )


def schedule_proactive_provisioning(request: Request, conv: Conversation, session_id: str) -> None:
    """Fire-and-forget: ensure the chat's standing proactive tasks exist (no-op otherwise)."""
    if not is_proactive_super_chat(conv):
        return
    state = request.app.state
    provisioner = getattr(state, "proactive_provisioner", None)
    if provisioner is None:
        provisioner = state.proactive_provisioner = ProactiveProvisioner(request.app)
    task = asyncio.create_task(provisioner.ensure(session_id, dict(request.headers)))
    _PROACTIVE_TASKS.add(task)
    task.add_done_callback(_PROACTIVE_TASKS.discard)
