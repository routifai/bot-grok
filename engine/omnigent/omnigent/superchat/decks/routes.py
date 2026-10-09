"""``POST /v1/decks/{artifact_id}/export``: the panel's Export buttons.

Wakes the person's Computer the way a message does, then runs the ``deck_export`` tool on its
runner (``/mcp/execute``) so the Chromium that renders the deck is the one in their Computer.
The result is a new artifact in the deck's chat.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel

from omnigent.errors import ErrorCode, OmnigentError
from omnigent.server.auth import AuthProvider
from omnigent.stores import ConversationStore
from omnigent.superchat.artifacts import (
    SqlAlchemyArtifactStore,
    load_artifact,
    request_owner,
)
from omnigent.superchat.decks.names import is_deck_name

#: How long the export waits for the Computer to wake and its runner to connect.
WAKE_TIMEOUT_S = 120.0
#: The helper's own limit is 180 s; leave room for the upload.
EXECUTE_TIMEOUT_S = 220.0


class DeckExportBody(BaseModel):
    """``POST /decks/{id}/export`` body."""

    format: Literal["pptx", "pdf"]


def create_decks_router(
    store: SqlAlchemyArtifactStore,
    *,
    conversation_store: ConversationStore,
    runner_router: Any = None,
    auth_provider: AuthProvider | None = None,
) -> APIRouter:
    """Build the decks router, mounted with ``prefix="/v1"`` after the artifacts router."""
    router = APIRouter()

    async def _wake(request: Request, session_id: str) -> Any:
        from omnigent.server.routes._sessions.common import get_server_runner_router
        from omnigent.server.routes._sessions.orchestration import ensure_runner_connected

        conv = await asyncio.to_thread(conversation_store.get_conversation, session_id)
        if conv is None:
            raise OmnigentError("Conversation not found", code=ErrorCode.NOT_FOUND)
        unavailable = OmnigentError(
            "Your Computer is still starting; try again shortly",
            code=ErrorCode.RUNNER_UNAVAILABLE,
        )
        try:
            client, _ = await asyncio.wait_for(
                ensure_runner_connected(
                    session_id=session_id,
                    conv=conv,
                    app_state=request.app.state,
                    conversation_store=conversation_store,
                    runner_router=runner_router or get_server_runner_router(),
                ),
                timeout=WAKE_TIMEOUT_S,
            )
        except TimeoutError:
            raise unavailable from None
        if client is None:
            raise unavailable
        return client

    @router.post("/decks/{artifact_id}/export")
    async def export_deck(
        request: Request, artifact_id: str, body: DeckExportBody
    ) -> dict[str, Any]:
        """Export a deck to ``pptx`` / ``pdf`` in the person's Computer as a new artifact."""
        item = await load_artifact(store, request_owner(request, auth_provider), artifact_id)
        if not is_deck_name(item.name):
            raise OmnigentError("That file isn't a deck", code=ErrorCode.INVALID_INPUT)
        session_id = item.parent_session_id
        client = await _wake(request, session_id)
        try:
            resp = await client.post(
                f"/v1/sessions/{session_id}/mcp/execute",
                json={
                    "method": "tools/call",
                    "params": {
                        "name": "deck_export",
                        "arguments": {"artifact_id": item.id, "format": body.format},
                    },
                },
                timeout=EXECUTE_TIMEOUT_S,
            )
            payload = resp.json()
        except Exception as exc:
            raise OmnigentError(
                f"The export couldn't reach your Computer: {exc}",
                code=ErrorCode.RUNNER_UNAVAILABLE,
            ) from exc
        failure = _failure(payload)
        if failure is not None:
            raise OmnigentError(failure, code=ErrorCode.INVALID_INPUT)
        try:
            result = json.loads(payload["result"]["output"])
        except (KeyError, TypeError, ValueError):
            result = None
        if not isinstance(result, dict):
            raise OmnigentError("The export didn't finish", code=ErrorCode.INVALID_INPUT)
        if result.get("error"):
            raise OmnigentError(str(result["error"])[:300], code=ErrorCode.INVALID_INPUT)
        result.pop("type", None)
        return result

    return router


def _failure(payload: Any) -> str | None:
    """The runner's JSON-RPC error message, or ``None`` when the call went through."""
    if not isinstance(payload, dict):
        return "The export didn't finish"
    err = payload.get("error")
    if err:
        message = err.get("message") if isinstance(err, dict) else err
        return str(message or "The export didn't finish")[:300]
    return None


__all__ = ["DeckExportBody", "create_decks_router"]
