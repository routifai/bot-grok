"""Runner-side handler for the taught-skill tools (skill_list, skill_run, skill_draft_save)."""

from __future__ import annotations

import json
from typing import Any

from omnigent.superchat._handler_http import HEX_ID_RE, error, finish, resolve_caller
from omnigent.superchat.feature import HandlerCtx
from omnigent.superchat.skills.tools import SKILL_HELPER_TOOL_NAMES


async def handle_taught_skill_tool(ctx: HandlerCtx, args: dict[str, Any]) -> str:
    """
    Runner-local handler for the taught-skill tools.

    Proxies the server's ``/v1/taught-skills`` endpoints. The top-level session lists and runs
    its saved skills; a Helper may only save a draft, and only for a skill that belongs to its
    own parent session.

    :param ctx: The call context (tool is one of :data:`SKILL_TOOL_NAMES`).
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
    if is_helper and tool_name not in SKILL_HELPER_TOOL_NAMES:
        return error(f"{tool_name} is not available to sub-agent sessions")
    if not is_helper and tool_name in SKILL_HELPER_TOOL_NAMES:
        return error(f"{tool_name} is only for the Helper that drafts a skill")
    try:
        if tool_name == "skill_draft_save":
            skill_id = args.get("skill_id")
            if not isinstance(skill_id, str) or not HEX_ID_RE.fullmatch(skill_id):
                return json.dumps({"error": "skill_draft_save requires the 32-character skill_id"})
            base = f"/v1/taught-skills/{skill_id.lower()}"
            owner_check = await server_client.get(base, timeout=30.0)
            if owner_check.status_code >= 400:
                return json.dumps({"error": f"server returned {owner_check.status_code}"})
            if owner_check.json().get("parent_session_id") != caller.parent_id:
                return json.dumps({"error": "skill_draft_save: not this helper's skill"})
            doc = {k: v for k, v in args.items() if k != "skill_id"}
            resp = await server_client.put(f"{base}/doc", json={"doc": doc}, timeout=30.0)
        elif tool_name == "skill_list":
            resp = await server_client.get(
                f"/v1/taught-skills?parent_session_id={conversation_id}&status=saved",
                timeout=30.0,
            )
        else:  # skill_run
            ref = args.get("skill")
            inputs = args.get("inputs") if isinstance(args.get("inputs"), dict) else {}
            if not isinstance(ref, str) or not ref.strip():
                return json.dumps({"error": "skill_run requires a skill id or name"})
            skill_id = ref.strip().lower()
            if not HEX_ID_RE.fullmatch(skill_id):
                listing = await server_client.get(
                    f"/v1/taught-skills?parent_session_id={conversation_id}&status=saved",
                    timeout=30.0,
                )
                found = [
                    s
                    for s in listing.json().get("skills", [])
                    if str(s.get("name", "")).lower() == ref.strip().lower()
                ]
                if listing.status_code >= 400 or not found:
                    return json.dumps({"error": f"no saved skill named {ref.strip()!r}"})
                skill_id = found[0]["id"]
            resp = await server_client.post(
                f"/v1/taught-skills/{skill_id}/render",
                json={"inputs": inputs, "parent_session_id": conversation_id},
                timeout=30.0,
            )
    except Exception as exc:  # noqa: BLE001
        return json.dumps({"error": f"{tool_name} failed: {exc}"})
    return finish(resp)
