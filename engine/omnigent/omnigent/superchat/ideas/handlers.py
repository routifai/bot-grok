"""Runner-side handlers for ``suggestion_create`` / ``suggestion_list``.

Proxies the server's ``/v1/suggestions`` endpoints. The Idea belongs to the top-level chat: a
Helper (sub-agent session) records it under its own parent, with itself as the source run.
"""

from __future__ import annotations

from typing import Any

from omnigent.superchat._handler_http import error, finish, resolve_caller
from omnigent.superchat.feature import HandlerCtx


async def handle_suggestion_tool(ctx: HandlerCtx, args: dict[str, Any]) -> str:
    """
    Run one suggestion tool.

    :param ctx: The call context.
    :param args: Parsed tool arguments.
    :returns: Tool output JSON string.
    """
    tool_name = ctx.tool_name
    caller = await resolve_caller(ctx)
    if isinstance(caller, str):
        return caller
    chat_id = caller.chat_id
    if not chat_id:
        return error(f"{tool_name}: no chat to attach to")
    try:
        if tool_name == "suggestion_list":
            resp = await caller.client.get(
                f"/v1/suggestions?parent_session_id={chat_id}&status=open", timeout=30.0
            )
        else:
            fields = {k: args.get(k) for k in ("title", "why", "message")}
            if not all(isinstance(v, str) and v.strip() for v in fields.values()):
                return error("suggestion_create requires title, why and message")
            payload: dict[str, object] = {"parent_session_id": chat_id, **fields}
            if caller.is_helper:
                payload["source_session_id"] = caller.conversation_id
            resp = await caller.client.post("/v1/suggestions", json=payload, timeout=30.0)
    except Exception as exc:  # noqa: BLE001
        return error(f"{tool_name} failed: {exc}")
    return finish(resp)
