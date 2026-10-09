"""Runner-side handler for ``files_search`` / ``files_read_page``: proxies the server."""

from __future__ import annotations

import json
from typing import Any

from omnigent.runtime.mcp_tool_result import encode_mcp_image_result
from omnigent.superchat._handler_http import HEX_ID_RE, error, finish, resolve_caller
from omnigent.superchat.feature import HandlerCtx

#: Marks a ``files_search`` result so the transcript can show its pages as citation chips.
SEARCH_RESULT_TYPE = "file_search"


async def handle_knowledge_tool(ctx: HandlerCtx, args: dict[str, Any]) -> str:
    """
    Run one knowledge tool.

    :param ctx: The call context.
    :param args: Parsed tool arguments.
    :returns: Tool output JSON string (an image envelope for a page that has an image).
    """
    tool_name = ctx.tool_name
    caller = await resolve_caller(ctx)
    if isinstance(caller, str):
        return caller
    try:
        if tool_name == "files_search":
            return await _search(caller.client, args)
        return await _read_page(caller.client, args)
    except Exception as exc:  # noqa: BLE001
        return error(f"{tool_name} failed: {exc}")


async def _search(client: Any, args: dict[str, Any]) -> str:
    query = args.get("query")
    if not isinstance(query, str) or not query.strip():
        return error("files_search requires a query")
    body: dict[str, Any] = {"query": query.strip()}
    file_ids = args.get("file_ids")
    if isinstance(file_ids, list) and file_ids:
        ids = [i for i in file_ids if isinstance(i, str) and HEX_ID_RE.match(i)]
        if not ids:
            return error("file_ids must be artifact ids")
        body["file_ids"] = ids
    if isinstance(args.get("k"), int) and not isinstance(args.get("k"), bool):
        body["k"] = max(1, min(args["k"], 25))
    resp = await client.post("/v1/knowledge/search", json=body, timeout=60.0)
    if resp.status_code >= 400:
        return finish(resp)
    return json.dumps({"type": SEARCH_RESULT_TYPE, **resp.json()})


async def _read_page(client: Any, args: dict[str, Any]) -> str:
    artifact_id, page = args.get("artifact_id"), args.get("page")
    if not isinstance(artifact_id, str) or not HEX_ID_RE.match(artifact_id):
        return error("files_read_page requires a valid artifact_id")
    if not isinstance(page, int) or isinstance(page, bool) or page < 1:
        return error("files_read_page requires a page number from 1")
    resp = await client.get(f"/v1/knowledge/files/{artifact_id}/pages/{page}", timeout=60.0)
    if resp.status_code >= 400:
        return finish(resp)
    found = resp.json()
    image = found.pop("image_base64", None)
    mime = found.pop("image_mime", None)
    if not image or not mime:
        return json.dumps(found)
    return encode_mcp_image_result(
        [
            {"type": "text", "text": json.dumps(found)},
            {"type": "image", "mimeType": mime, "data": image},
        ],
        is_error=False,
    )
