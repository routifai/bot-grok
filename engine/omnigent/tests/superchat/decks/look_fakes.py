"""A fake Omnigent server for the look gate: one session, its stored items and memory claims."""

from __future__ import annotations

import json
from typing import Any

import httpx

from omnigent.superchat.feature import HandlerCtx

SESSION = "conv_look"


def user(text: str, **extra: Any) -> dict[str, Any]:
    """A stored user message."""
    return {
        "type": "message",
        "role": "user",
        "content": [{"type": "input_text", "text": text}],
    } | extra


def card_output(themes: list[tuple[str, str]]) -> dict[str, Any]:
    """A stored ``ask`` card output offering ``(label, theme id)`` deck themes."""
    options = [
        {"id": f"opt-{i}", "label": label, "preview": {"kind": "deck-theme", "id": theme}}
        for i, (label, theme) in enumerate(themes, 1)
    ]
    card = {"type": "card", "card": "ask", "data": {"question": "Which look?", "options": options}}
    return {"type": "function_call_output", "call_id": "c1", "output": json.dumps(card)}


def ctx(
    items: list[dict[str, Any]] | None = None,
    *,
    kind: str = "default",
    claims: list[dict[str, Any]] | None = None,
) -> HandlerCtx:
    """A call context whose server holds *items* (oldest first), *kind* and *claims*."""

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == f"/v1/sessions/{SESSION}":
            return httpx.Response(200, json={"kind": kind, "parent_session_id": None})
        if path == f"/v1/sessions/{SESSION}/items":
            assert request.url.params["order"] == "desc"
            return httpx.Response(200, json={"data": list(reversed(items or []))})
        if path == f"/v1/sessions/{SESSION}/memory/claims":
            return httpx.Response(200, json={"claims": claims or []})
        return httpx.Response(404)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://srv")
    return HandlerCtx(tool_name="deck_new", server_client=client, conversation_id=SESSION)


def helper_ctx() -> HandlerCtx:
    """A Helper session: background work, where any look passes."""
    return ctx(kind="sub_agent")
