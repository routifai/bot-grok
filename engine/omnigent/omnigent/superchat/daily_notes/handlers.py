"""Runner-side handler for ``daily_note_get`` / ``daily_note_update``.

Proxies the server's daily-note endpoints. A Helper writes under its parent chat.
"""

from __future__ import annotations

from typing import Any

from omnigent.superchat._handler_http import error, finish, resolve_caller
from omnigent.superchat.feature import HandlerCtx


async def handle_daily_note_tool(ctx: HandlerCtx, args: dict[str, Any]) -> str:
    """
    Run one daily-note tool.

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
        if tool_name == "daily_note_get":
            resp = await caller.client.get("/v1/me/daily-notes/today", timeout=30.0)
        else:
            sections = {k: v for k, v in args.items() if isinstance(v, str) and k != "date"}
            payload: dict[str, Any] = {"parent_session_id": chat_id, "sections": sections}
            if isinstance(args.get("date"), str):
                payload["date"] = args["date"]
            resp = await caller.client.post("/v1/daily-notes/write", json=payload, timeout=30.0)
    except Exception as exc:  # noqa: BLE001
        return error(f"{tool_name} failed: {exc}")
    return finish(resp)
