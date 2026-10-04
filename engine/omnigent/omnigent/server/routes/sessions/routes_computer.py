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
from omnigent.stores.permission_store import PermissionStore

# Who is in control of a sandbox's screen, keyed by ``(provider, sandbox_id)`` -> control token.
# Known limit (P1): in server memory only, so a server restart forgets a take-over until the
# person releases or re-takes it, and replicas do not share it. Sessions on the same
# sandbox (one Muse's computer) share one entry.
_control_tokens: dict[tuple[str, str], str] = {}


def is_computer_in_control(provider: str, sandbox_id: str) -> bool:
    """Whether a person currently holds control of this sandbox's screen."""
    return (provider, sandbox_id) in _control_tokens


def register_computer_routes(
    router: APIRouter,
    *,
    conversation_store: ConversationStore,
    auth_provider: AuthProvider | None = None,
    permission_store: PermissionStore | None = None,
) -> None:
    """Register the computer routes on router."""

    def _target(request: Request, session_id: str) -> tuple[SandboxHostLauncher, str] | None:
        """The screen-capable ``(launcher, sandbox_id)`` the session runs on, else ``None``."""
        from omnigent.server.managed_hosts import screen_target_for_host

        conv = conversation_store.get_conversation(session_id)
        host_store = getattr(request.app.state, "host_store", None)
        if conv is None or conv.host_id is None or host_store is None:
            return None
        host = host_store.get_host(conv.host_id)
        if host is None:
            return None
        return screen_target_for_host(host, getattr(request.app.state, "sandbox_config", None))

    def _require_target(request: Request, session_id: str) -> tuple[SandboxHostLauncher, str]:
        target = _target(request, session_id)
        if target is None:
            raise OmnigentError("this session has no computer screen", code=ErrorCode.NOT_FOUND)
        return target

    @router.get(
        "/sessions/{session_id}/computer",
        include_in_schema=False,
        response_model=None,
    )
    async def get_computer(request: Request, session_id: str) -> dict[str, Any]:
        """
        Report whether the session has a computer screen and whether a person controls it.

        :param session_id: Session identifier, e.g. ``"conv_abc123"``.
        :returns: ``{"available": bool, "in_control": bool}``.
        """
        user_id = _get_user_id(request, auth_provider)
        await _require_access_and_level(
            user_id, session_id, LEVEL_READ, permission_store, conversation_store
        )
        target = await asyncio.to_thread(_target, request, session_id)
        if target is None:
            return {"available": False, "in_control": False}
        launcher, sandbox_id = target
        return {
            "available": True,
            "in_control": is_computer_in_control(launcher.provider, sandbox_id),
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
        launcher, sandbox_id = await asyncio.to_thread(_require_target, request, session_id)
        key = (launcher.provider, sandbox_id)
        # Reuse a held token: minting a new one would cut off the person's open screen.
        token = (_control_tokens.get(key) or secrets.token_urlsafe(24)) if interactive else None
        url = await asyncio.to_thread(
            lambda: launcher.screen_url(sandbox_id, interactive=interactive, control_token=token)
        )
        if token is not None:
            _control_tokens[key] = token
        return {"screen_url": url, "in_control": key in _control_tokens}

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
        launcher, sandbox_id = await asyncio.to_thread(_require_target, request, session_id)
        await asyncio.to_thread(launcher.release_control, sandbox_id)
        _control_tokens.pop((launcher.provider, sandbox_id), None)
        url = await asyncio.to_thread(
            lambda: launcher.screen_url(sandbox_id, interactive=False, control_token=None)
        )
        return {"screen_url": url, "in_control": False}
