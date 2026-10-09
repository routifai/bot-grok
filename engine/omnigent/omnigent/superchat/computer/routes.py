"""Session computer routes: see the sandbox screen, take it over, hand it back."""

from __future__ import annotations

import asyncio
import secrets
from typing import Any

from fastapi import APIRouter, Request

from omnigent.errors import ErrorCode, OmnigentError
from omnigent.onboarding.sandboxes.base import SandboxHostLauncher
from omnigent.server.auth import LEVEL_EDIT, LEVEL_READ, AuthProvider
from omnigent.server.routes._auth_helpers import (
    get_user_id as _get_user_id,
)
from omnigent.server.routes._auth_helpers import (
    require_access_and_level as _require_access_and_level,
)
from omnigent.stores import ConversationStore
from omnigent.stores.host_store import HostStore
from omnigent.stores.permission_store import PermissionStore
from omnigent.superchat.computer.target import require_target, screen_target

# Who is in control of a computer screen is a control token on the managed host row, so it
# survives a server restart and is shared by replicas. Sessions on the same host (one
# computer) share one token.


def register_computer_routes(
    router: APIRouter,
    *,
    conversation_store: ConversationStore,
    auth_provider: AuthProvider | None = None,
    permission_store: PermissionStore | None = None,
) -> None:
    """Register the computer routes on router."""

    def _target(
        request: Request, session_id: str
    ) -> tuple[SandboxHostLauncher, str, str, HostStore] | None:
        return screen_target(conversation_store, request, session_id)

    def _require_target(
        request: Request, session_id: str
    ) -> tuple[SandboxHostLauncher, str, str, HostStore]:
        return require_target(conversation_store, request, session_id)

    @router.get(
        "/sessions/{session_id}/computer",
        include_in_schema=False,
        response_model=None,
    )
    async def get_computer(request: Request, session_id: str) -> dict[str, Any]:
        """
        Report whether the session has a computer screen and whether a person controls it.

        :param session_id: Session identifier, e.g. ``"conv_abc123"``.
        :returns: ``{"available": bool, "in_control": bool, "ready": bool, "launch": ...}``;
            ``ready`` is whether the Conversation's runner is connected (Files and tools can reach
            it). ``launch`` is ``{"stage": ..., "error": ...}`` while the managed-sandbox launch
            is in flight or has failed (the session snapshot's ``sandbox_status``), else ``null``.
        """
        user_id = _get_user_id(request, auth_provider)
        await _require_access_and_level(
            user_id, session_id, LEVEL_READ, permission_store, conversation_store
        )
        from omnigent.server.routes.sessions import _session_sandbox_status_cache

        cached = _session_sandbox_status_cache.get(session_id)
        launch = {"stage": cached.stage, "error": cached.error} if cached is not None else None
        target = await asyncio.to_thread(_target, request, session_id)
        if target is None:
            return {"available": False, "in_control": False, "ready": False, "launch": launch}
        _launcher, _sandbox_id, host_id, host_store = target
        held = await asyncio.to_thread(host_store.get_computer_control_token, host_id)
        conv = await asyncio.to_thread(conversation_store.get_conversation, session_id)
        tunnels = getattr(request.app.state, "tunnel_registry", None)
        ready = bool(
            conv is not None
            and conv.runner_id
            and tunnels is not None
            and tunnels.get(conv.runner_id) is not None
        )
        return {
            "available": True,
            "in_control": held is not None,
            "ready": ready,
            "launch": launch,
        }

    @router.post(
        "/sessions/{session_id}/computer/screen",
        include_in_schema=False,
        response_model=None,
    )
    async def computer_screen(
        request: Request, session_id: str, body: dict[str, Any]
    ) -> dict[str, Any]:
        """
        Return the screen viewer URL; ``interactive`` takes over the computer.

        :param session_id: Session identifier, e.g. ``"conv_abc123"``.
        :param body: ``{"interactive": bool}``. ``true`` mints a control token, records that a
            person is in control, and returns the interactive URL; ``false`` returns the
            view-only URL.
        :returns: ``{"screen_url": str, "in_control": bool}``.
        :raises OmnigentError: 404 when the session has no computer screen.
        """
        user_id = _get_user_id(request, auth_provider)
        await _require_access_and_level(
            user_id, session_id, LEVEL_EDIT, permission_store, conversation_store
        )
        interactive = body.get("interactive")
        if not isinstance(interactive, bool):
            raise OmnigentError(
                "computer screen requires a boolean 'interactive'", code=ErrorCode.INVALID_INPUT
            )
        launcher, sandbox_id, host_id, host_store = await asyncio.to_thread(
            _require_target, request, session_id
        )
        held = await asyncio.to_thread(host_store.get_computer_control_token, host_id)
        # Reuse a held token: minting a new one would cut off the person's open screen.
        token = (held or secrets.token_urlsafe(24)) if interactive else None
        url = await asyncio.to_thread(
            lambda: launcher.screen_url(sandbox_id, interactive=interactive, control_token=token)
        )
        if token is not None and token != held:
            await asyncio.to_thread(host_store.set_computer_control_token, host_id, token)
        return {"screen_url": url, "in_control": token is not None or held is not None}

    @router.post(
        "/sessions/{session_id}/computer/release",
        include_in_schema=False,
        response_model=None,
    )
    async def computer_release(request: Request, session_id: str) -> dict[str, Any]:
        """
        Hand the computer back: revoke control and return the view-only URL.

        :param session_id: Session identifier, e.g. ``"conv_abc123"``.
        :returns: ``{"screen_url": str, "in_control": False}``.
        :raises OmnigentError: 404 when the session has no computer screen.
        """
        user_id = _get_user_id(request, auth_provider)
        await _require_access_and_level(
            user_id, session_id, LEVEL_EDIT, permission_store, conversation_store
        )
        launcher, sandbox_id, host_id, host_store = await asyncio.to_thread(
            _require_target, request, session_id
        )
        await asyncio.to_thread(launcher.release_control, sandbox_id)
        await asyncio.to_thread(host_store.set_computer_control_token, host_id, None)
        url = await asyncio.to_thread(
            lambda: launcher.screen_url(sandbox_id, interactive=False, control_token=None)
        )
        return {"screen_url": url, "in_control": False}
