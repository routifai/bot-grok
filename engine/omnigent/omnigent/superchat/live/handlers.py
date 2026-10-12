"""Runner-side handlers of the live artifact tools: they call the engine's routes."""

from __future__ import annotations

import json
from typing import Any
from urllib.parse import quote

from omnigent.superchat._handler_http import Caller, error, finish, resolve_caller
from omnigent.superchat.feature import HandlerCtx
from omnigent.superchat.live.tools import (
    CHECKED_TOOL_NAME,
    CONTEXT_TOOL_NAME,
    HELPER_TOOL_NAMES,
    KEEP_TOOL_NAME,
    SAVE_TOOL_NAME,
)

_WEEKDAYS = {d: d[:2].upper() for d in ("monday", "tuesday", "wednesday", "thursday", "friday")}
_WEEKDAYS |= {"saturday": "SA", "sunday": "SU"}


def build_rrule(args: dict[str, Any]) -> str:
    """The RRULE for ``frequency`` / ``time`` / ``weekday`` / ``month_day``.

    :raises ValueError: with a message the model can act on.
    """
    frequency = str(args.get("frequency") or "").lower()
    try:
        hour, minute = (int(part) for part in str(args.get("time") or "").split(":"))
    except ValueError as exc:
        raise ValueError("time must be HH:MM, e.g. 08:00") from exc
    if not (0 <= hour < 24 and 0 <= minute < 60):
        raise ValueError("time must be HH:MM, e.g. 08:00")
    rule = f"BYHOUR={hour};BYMINUTE={minute}"
    if frequency == "daily":
        return f"FREQ=DAILY;{rule}"
    if frequency == "weekly":
        day = _WEEKDAYS.get(str(args.get("weekday") or "").lower())
        if day is None:
            raise ValueError("weekly needs a weekday (monday ... sunday)")
        return f"FREQ=WEEKLY;BYDAY={day};{rule}"
    if frequency == "monthly":
        month_day = args.get("month_day")
        if not isinstance(month_day, int) or not 1 <= month_day <= 28:
            raise ValueError("monthly needs month_day between 1 and 28")
        return f"FREQ=MONTHLY;BYMONTHDAY={month_day};{rule}"
    raise ValueError("frequency must be daily, weekly or monthly")


async def handle_live_tool(ctx: HandlerCtx, args: dict[str, Any]) -> str:
    """
    Run one live artifact tool.

    :param ctx: The call context.
    :param args: Parsed tool arguments.
    :returns: Tool output JSON string.
    """
    caller = await resolve_caller(ctx)
    if isinstance(caller, str):
        return caller
    name = args.get("name")
    chat_id = caller.chat_id
    if not chat_id or not isinstance(name, str) or not name.strip():
        return error(f"{ctx.tool_name} needs a page name in a chat")
    if (ctx.tool_name in HELPER_TOOL_NAMES) != caller.is_helper:
        return error(f"{ctx.tool_name} is not available here")
    try:
        if caller.is_helper:
            return await _helper_call(caller, ctx.tool_name, chat_id, name.strip(), args)
        return await _manage(caller, ctx.tool_name, chat_id, name.strip(), args)
    except Exception as exc:  # noqa: BLE001
        return error(f"{ctx.tool_name} failed: {exc}")


async def _helper_call(
    caller: Caller, tool: str, chat_id: str, name: str, args: dict[str, Any]
) -> str:
    query = f"parent_session_id={chat_id}&name={quote(name)}"
    if tool == CONTEXT_TOOL_NAME:
        return finish(await caller.client.get(f"/v1/live-artifacts/context?{query}", timeout=30.0))
    if tool == CHECKED_TOOL_NAME:
        body: dict[str, Any] = {"facts": args.get("facts") or {}}
        path = "checked"
    else:
        body = {
            "base_version": args.get("base_version"),
            "changes": args.get("changes") or [],
            "facts": args.get("facts") or {},
        }
        if args.get("sources"):
            body["sources"] = [{"ref": str(s)} for s in args["sources"]]
        path = "save"
    resp = await caller.client.post(f"/v1/live-artifacts/{path}?{query}", json=body, timeout=60.0)
    if resp.status_code == 409 and tool == SAVE_TOOL_NAME:
        return error("the page changed since you read it; call live_update_context again")
    return finish(resp)


async def _manage(caller: Caller, tool: str, chat_id: str, name: str, args: dict[str, Any]) -> str:
    listing = await caller.client.get(f"/v1/artifacts?parent_session_id={chat_id}", timeout=30.0)
    found = next((a for a in listing.json().get("artifacts", []) if a["name"] == name), None)
    if found is None:
        return error(f"no saved file named {name} in this chat")
    url = f"/v1/artifacts/{found['id']}/live"
    if tool != KEEP_TOOL_NAME:
        return finish(await caller.client.delete(url, timeout=30.0))
    try:
        body: dict[str, Any] = {"rrule": build_rrule(args)}
    except ValueError as exc:
        return error(str(exc))
    if args.get("sources") is not None:
        body["sources"] = [{"ref": str(s)} for s in args["sources"]]
    if args.get("tell"):
        body["tell"] = args["tell"]
    resp = await caller.client.put(url, json=body, timeout=30.0)
    if resp.status_code >= 400:
        return finish(resp)
    return json.dumps({"kept_updated": name, **resp.json()})
