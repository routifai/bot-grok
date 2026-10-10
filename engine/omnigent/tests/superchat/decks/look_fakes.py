"""A fake Omnigent server for the look gate: one session, its stored items and memory claims."""

from __future__ import annotations

import json
from typing import Any

import httpx

from omnigent.context.labels import SCHEDULED_HELPER_LABEL_KEY
from omnigent.superchat.feature import HandlerCtx

SESSION = "conv_look"


def user(text: str, **extra: Any) -> dict[str, Any]:
    """A stored user message."""
    return {
        "type": "message",
        "role": "user",
        "content": [{"type": "input_text", "text": text}],
    } | extra


def card_call(tool: str = "mcp__omnigent__ask_clarification") -> dict[str, Any]:
    """The stored call of *tool* that :func:`card_output` answers."""
    return {"type": "function_call", "name": tool, "call_id": "c1", "arguments": "{}"}


def card_output(themes: list[tuple[str, str]]) -> dict[str, Any]:
    """A stored ``ask`` card output offering ``(label, theme id)`` deck themes."""
    options = [
        {"id": f"opt-{i}", "label": label, "preview": {"kind": "deck-theme", "id": theme}}
        for i, (label, theme) in enumerate(themes, 1)
    ]
    card = {"type": "card", "card": "ask", "data": {"question": "Which look?", "options": options}}
    return {"type": "function_call_output", "call_id": "c1", "output": json.dumps(card)}


HELPER = "conv_helper"


def ctx(
    items: list[dict[str, Any]] | None = None,
    *,
    claims: list[dict[str, Any]] | None = None,
    helper: dict[str, str] | None = None,
    root_labels: dict[str, str] | None = None,
) -> HandlerCtx:
    """A call from the chat :data:`SESSION` holding *items* (oldest first) and *claims*; with
    *helper* (that Helper's labels), the call comes from a Helper the chat started."""
    sessions = {
        SESSION: {"kind": "default", "parent_session_id": None, "labels": root_labels or {}}
    }
    if helper is not None:
        sessions[HELPER] = {"kind": "sub_agent", "parent_session_id": SESSION, "labels": helper}

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        for sid, info in sessions.items():
            if path == f"/v1/sessions/{sid}":
                return httpx.Response(200, json=info)
        if path == f"/v1/sessions/{SESSION}/items":
            assert request.url.params["order"] == "desc"
            return httpx.Response(200, json={"data": list(reversed(items or []))})
        if path == f"/v1/sessions/{SESSION}/memory/claims":
            return httpx.Response(200, json={"claims": claims or []})
        return httpx.Response(404)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://srv")
    caller = HELPER if helper is not None else SESSION
    return HandlerCtx(tool_name="deck_new", server_client=client, conversation_id=caller)


def helper_ctx() -> HandlerCtx:
    """A scheduled Helper: background work, where ``look_from: background`` passes."""
    return ctx(helper={SCHEDULED_HELPER_LABEL_KEY: "task1"})
