"""Which computer screen a session sits on: the public lookup other capabilities build on."""

from __future__ import annotations

from typing import TYPE_CHECKING

from omnigent.errors import ErrorCode, OmnigentError

if TYPE_CHECKING:
    from fastapi import Request

    from omnigent.onboarding.sandboxes.base import SandboxHostLauncher
    from omnigent.stores import ConversationStore
    from omnigent.stores.host_store import HostStore


def screen_target(
    conversation_store: ConversationStore, request: Request, session_id: str
) -> tuple[SandboxHostLauncher, str, str, HostStore] | None:
    """The screen-capable ``(launcher, sandbox_id, host_id, host_store)`` of the session."""
    from omnigent.server.managed_hosts import screen_target_for_host

    conv = conversation_store.get_conversation(session_id)
    host_store = getattr(request.app.state, "host_store", None)
    if conv is None or conv.host_id is None or host_store is None:
        return None
    host = host_store.get_host(conv.host_id)
    if host is None:
        return None
    screen = screen_target_for_host(host, getattr(request.app.state, "sandbox_config", None))
    if screen is None:
        return None
    return screen[0], screen[1], host.host_id, host_store


def require_target(
    conversation_store: ConversationStore, request: Request, session_id: str
) -> tuple[SandboxHostLauncher, str, str, HostStore]:
    """:func:`screen_target`, or a 404 when the session has no computer screen."""
    target = screen_target(conversation_store, request, session_id)
    if target is None:
        raise OmnigentError("this session has no computer screen", code=ErrorCode.NOT_FOUND)
    return target
