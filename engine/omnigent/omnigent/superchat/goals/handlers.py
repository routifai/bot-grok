"""Runner-side handler for the ``objective_*`` tools."""

from __future__ import annotations

import json
import re
from typing import Any

import httpx

from omnigent.superchat._handler_http import HEX_ID_RE, finish, resolve_caller
from omnigent.superchat.feature import HandlerCtx
from omnigent.superchat.goals.tools import OBJECTIVE_HELPER_TOOL_NAMES


def _objective_plan(raw: object) -> list[dict[str, str]] | None:
    """Normalize a tool plan (title strings or ``{id?, title}``) for the REST body."""
    if not isinstance(raw, list):
        return None
    plan: list[dict[str, str]] = []
    for item in raw:
        if isinstance(item, str) and item.strip():
            plan.append({"title": item.strip()})
        elif isinstance(item, dict) and isinstance(item.get("title"), str):
            entry = {"title": item["title"]}
            if isinstance(item.get("id"), str) and item["id"]:
                entry["id"] = item["id"]
            plan.append(entry)
        else:
            return None
    return plan


_TITLE_TOKEN_RE = re.compile(r"[a-z0-9]+")
_TITLE_STOPWORDS = frozenset({"a", "an", "the", "of", "for", "to", "and", "our", "my"})


def _title_tokens(title: str) -> frozenset[str]:
    """Lowercased word set of a goal title, minus filler words."""
    return frozenset(
        t for t in _TITLE_TOKEN_RE.findall(title.lower()) if t not in _TITLE_STOPWORDS
    )


def _titles_match(a: str, b: str) -> bool:
    """True when two goal titles are clearly the same goal."""
    ta, tb = _title_tokens(a), _title_tokens(b)
    if not ta or not tb:
        return False
    if ta <= tb or tb <= ta:
        return True
    return len(ta & tb) / len(ta | tb) >= 0.6


async def _find_duplicate_objective(
    server_client: httpx.AsyncClient, conversation_id: str, title: str
) -> dict[str, object] | None:
    """Return the owner's active objective in this Conversation that matches *title*."""
    resp = await server_client.get(
        f"/v1/objectives?parent_session_id={conversation_id}", timeout=30.0
    )
    if resp.status_code >= 400:
        return None
    body = resp.json()
    items = body.get("objectives") if isinstance(body, dict) else None
    for obj in items if isinstance(items, list) else []:
        if (
            isinstance(obj, dict)
            and obj.get("status") == "active"
            and isinstance(obj.get("title"), str)
            and _titles_match(title, obj["title"])
        ):
            return obj
    return None


async def handle_objective_tool(ctx: HandlerCtx, args: dict[str, Any]) -> str:
    """
    Runner-local handler for the ``objective_*`` family.

    Proxies the server's ``/v1/objectives`` endpoints. A Helper (sub-agent
    session) may only read, record task progress and propose, and only on an
    objective that belongs to its own parent session; ownership is enforced
    server-side.

    :param ctx: The call context (tool is one of :data:`OBJECTIVE_TOOL_NAMES`).
    :param args: Parsed tool arguments.
    :returns: Tool output JSON string.
    """
    tool_name = ctx.tool_name
    caller = await resolve_caller(ctx)
    if isinstance(caller, str):
        return caller
    server_client = caller.client
    conversation_id = caller.conversation_id
    is_helper = caller.is_helper
    if is_helper and tool_name not in OBJECTIVE_HELPER_TOOL_NAMES:
        return json.dumps({"error": f"{tool_name} is not available to sub-agent sessions"})

    objective_id = args.get("objective_id")
    if tool_name not in ("objective_create", "objective_list"):
        if not isinstance(objective_id, str) or not HEX_ID_RE.fullmatch(objective_id):
            return json.dumps({"error": f"{tool_name} requires a 32-character hex objective_id"})
        objective_id = objective_id.lower()
    base = f"/v1/objectives/{objective_id}"

    try:
        if is_helper and tool_name != "objective_list":
            owner_check = await server_client.get(base, timeout=30.0)
            if owner_check.status_code >= 400:
                return json.dumps({"error": f"server returned {owner_check.status_code}"})
            if owner_check.json().get("parent_session_id") != caller.parent_id:
                return json.dumps({"error": f"{tool_name}: not this helper's objective"})
        if tool_name == "objective_create":
            plan = _objective_plan(args.get("plan"))
            if plan is None or not isinstance(args.get("title"), str):
                return json.dumps({"error": "objective_create requires title and a plan list"})
            existing = await _find_duplicate_objective(
                server_client, conversation_id, args["title"]
            )
            if existing is not None:
                return json.dumps(
                    {
                        **existing,
                        "note": "already exists — update it or propose a plan change",
                        "already_exists": True,
                    }
                )
            payload: dict[str, object] = {
                "parent_session_id": conversation_id,
                "title": args["title"],
                "plan": plan,
            }
            for src, dst in (("description", "description"), ("due", "due"), ("cadence", "rrule")):
                if isinstance(args.get(src), str):
                    payload[dst] = args[src]
            resp = await server_client.post("/v1/objectives", json=payload, timeout=30.0)
        elif tool_name == "objective_list":
            resp = await server_client.get(
                f"/v1/objectives?parent_session_id={conversation_id}", timeout=30.0
            )
        elif tool_name == "objective_get":
            resp = await server_client.get(base, timeout=30.0)
        elif tool_name == "objective_update_task":
            task_id = args.get("task_id")
            if not isinstance(task_id, str) or not HEX_ID_RE.fullmatch(task_id):
                return json.dumps({"error": "objective_update_task requires a hex task_id"})
            body = {k: args[k] for k in ("status", "note") if k in args}
            resp = await server_client.patch(
                f"{base}/tasks/{task_id.lower()}", json=body, timeout=30.0
            )
        else:  # objective_propose
            plan = _objective_plan(args.get("plan"))
            if plan is None or not isinstance(args.get("reason"), str):
                return json.dumps({"error": "objective_propose requires reason and a plan list"})
            resp = await server_client.post(
                f"{base}/proposals", json={"reason": args["reason"], "plan": plan}, timeout=30.0
            )
    except Exception as exc:  # noqa: BLE001
        return json.dumps({"error": f"{tool_name} failed: {exc}"})

    return finish(resp)
