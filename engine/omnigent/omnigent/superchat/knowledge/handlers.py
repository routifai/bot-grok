"""Runner-side handler for the knowledge tools: runs in the Computer, answers from its index.

``files_search`` / ``files_read_page`` are the Muse's tools. ``files_status`` / ``files_thumbnail``
/ ``files_reindex`` are never offered to a model: the engine's relays call them (through the
runner's ``/mcp/execute``) to answer Nova's Library badges and citation chips.
"""

from __future__ import annotations

import asyncio
import base64
import json
from typing import Any

from omnigent.runner.knowledge.indexer import DEFAULT_K, MAX_K
from omnigent.runner.knowledge.runtime import KnowledgeRuntime, configure, get_runtime
from omnigent.runtime.mcp_tool_result import encode_mcp_image_result
from omnigent.superchat._handler_http import HEX_ID_RE, error
from omnigent.superchat.feature import HandlerCtx

#: Marks a ``files_search`` result so the transcript can show its pages as citation chips.
SEARCH_RESULT_TYPE = "file_search"


def _runtime(ctx: HandlerCtx) -> KnowledgeRuntime:
    client = ctx.server_client
    if client is not None:
        configure(str(client.base_url))
    runtime = get_runtime()
    runtime.start()
    return runtime


async def handle_knowledge_tool(ctx: HandlerCtx, args: dict[str, Any]) -> str:
    """
    Run one knowledge tool against the Computer's index.

    :param ctx: The call context.
    :param args: Parsed tool arguments.
    :returns: Tool output JSON string (an image envelope for a page that has an image).
    """
    runtime = _runtime(ctx)
    try:
        return await asyncio.to_thread(_run, runtime, ctx.tool_name, args)
    except Exception as exc:  # noqa: BLE001
        return error(f"{ctx.tool_name} failed: {exc}")


def _run(runtime: KnowledgeRuntime, tool_name: str, args: dict[str, Any]) -> str:
    if tool_name == "files_search":
        return _search(runtime, args)
    if tool_name == "files_read_page":
        return _read_page(runtime, args)
    if tool_name == "files_status":
        return json.dumps(runtime.indexer.status())
    if tool_name == "files_thumbnail":
        return _thumbnail(runtime, args)
    if tool_name == "files_reindex":
        queued = runtime.indexer.reindex()
        runtime.kick()
        return json.dumps({"queued": queued})
    return error(f"unknown knowledge tool: {tool_name}")


def _page_number(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 1 else None


def _search(runtime: KnowledgeRuntime, args: dict[str, Any]) -> str:
    query = args.get("query")
    if not isinstance(query, str) or not query.strip():
        return error("files_search requires a query")
    file_ids = args.get("file_ids")
    ids: list[str] | None = None
    if isinstance(file_ids, list) and file_ids:
        ids = [i for i in file_ids if isinstance(i, str) and HEX_ID_RE.match(i)]
        if not ids:
            return error("file_ids must be file ids from an earlier search")
    k = args.get("k")
    limit = max(1, min(k, MAX_K)) if isinstance(k, int) and not isinstance(k, bool) else DEFAULT_K
    found = runtime.indexer.search(query.strip(), file_ids=ids, k=limit)
    return json.dumps({"type": SEARCH_RESULT_TYPE, **found})


def _read_page(runtime: KnowledgeRuntime, args: dict[str, Any]) -> str:
    file_id, path, page = args.get("file_id"), args.get("path"), _page_number(args.get("page"))
    if not (isinstance(file_id, str) and HEX_ID_RE.match(file_id)) and not (
        isinstance(path, str) and path
    ):
        return error("files_read_page requires a file_id (from files_search) or a path")
    if page is None:
        return error("files_read_page requires a page number from 1")
    row = runtime.indexer.resolve(file_id if isinstance(file_id, str) else None, path)
    if row is None:
        return error("That file isn't in your search index (yet)")
    found = runtime.indexer.page(row, page)
    if found is None:
        return error("Page not found")
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


def _thumbnail(runtime: KnowledgeRuntime, args: dict[str, Any]) -> str:
    file_id, page = args.get("file_id"), _page_number(args.get("page"))
    if not (isinstance(file_id, str) and HEX_ID_RE.match(file_id)) or page is None:
        return error("files_thumbnail requires file_id and page")
    data = runtime.indexer.thumbnail(file_id, page)
    if data is None:
        return error("no thumbnail")
    return json.dumps(
        {"image_base64": base64.b64encode(data).decode(), "image_mime": "image/webp"}
    )
