"""Change an existing session's working directory (``PUT /v1/sessions/{id}/workspace``).

A session's ``workspace`` is set at create/fork. This route is the one generic way to move it
afterwards (a Super Chat opening a Project folder, for one). The new path is validated exactly
like a create-time workspace: it must exist on the session's host and stay inside the agent's
``os_env.cwd`` boundary (the host resolves symlinks, so ``..`` or a link cannot escape). Only
the owner may change it. The server persists the path, then tells the runner to forget its
cached copy; the runner re-reads it from the server, so the database stays the one source.

When it takes effect: the next tool call. A call already running keeps the directory it started
in; every later call in the same turn, and every later turn, uses the new one.
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Request
from pydantic import BaseModel

from omnigent.errors import ErrorCode, OmnigentError
from omnigent.runner.routing import RunnerRouter
from omnigent.runtime.agent_cache import AgentCache
from omnigent.server.auth import LEVEL_OWNER, AuthProvider
from omnigent.server.routes._auth_helpers import get_user_id as _get_user_id
from omnigent.server.routes._auth_helpers import require_access as _require_access
from omnigent.server.routes._errors import session_not_found as _session_not_found
from omnigent.server.routes._sessions.helpers import (
    _forward_session_change_to_runner,
    _validate_session_workspace,
)
from omnigent.stores import AgentStore, ConversationStore
from omnigent.stores.permission_store import PermissionStore


class SetSessionWorkspaceRequest(BaseModel):
    """Body of ``PUT /v1/sessions/{id}/workspace``.

    :param workspace: Absolute path on the session's host, e.g.
        ``"/home/aiden/workspace/projects/q3-deck"``.
    """

    workspace: str


class SessionWorkspaceResponse(BaseModel):
    """The canonical workspace now stored on the session."""

    workspace: str


def register_workspace_routes(
    router: APIRouter,
    *,
    conversation_store: ConversationStore,
    agent_store: AgentStore,
    runner_router: RunnerRouter | None = None,
    auth_provider: AuthProvider | None = None,
    permission_store: PermissionStore | None = None,
    agent_cache: AgentCache | None = None,
) -> None:
    """Register the session working-directory route on router."""

    @router.put("/sessions/{session_id}/workspace", response_model=SessionWorkspaceResponse)
    async def set_session_workspace(
        request: Request, session_id: str, body: SetSessionWorkspaceRequest
    ) -> SessionWorkspaceResponse:
        """Move the session's working directory (owner only, inside the agent boundary)."""
        user_id = _get_user_id(request, auth_provider)
        await _require_access(
            user_id, session_id, LEVEL_OWNER, permission_store, conversation_store
        )
        conv = await asyncio.to_thread(conversation_store.get_conversation, session_id)
        if conv is None or conv.agent_id is None:
            raise _session_not_found()
        if conv.host_id is None:
            raise OmnigentError(
                "This session has no host workspace to change",
                code=ErrorCode.INVALID_INPUT,
            )
        agent = await asyncio.to_thread(agent_store.get, conv.agent_id)
        if agent is None:
            raise _session_not_found()
        canonical = await _validate_session_workspace(
            user_id=user_id,
            host_id=conv.host_id,
            workspace=body.workspace,
            agent=agent,
            agent_cache=agent_cache,
            request=request,
        )
        await asyncio.to_thread(
            conversation_store.set_host_id, session_id, conv.host_id, canonical
        )
        forwarded = await _forward_session_change_to_runner(
            session_id, runner_router, {"type": "workspace_change"}
        )
        if forwarded is not None and forwarded.status_code >= 400:
            raise OmnigentError(
                "The runner did not pick up the new working directory",
                code=ErrorCode.RUNNER_UNAVAILABLE,
            )
        return SessionWorkspaceResponse(workspace=canonical)
