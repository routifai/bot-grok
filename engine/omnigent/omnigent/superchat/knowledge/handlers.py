"""Runner-side handler for the knowledge tools: runs in the Computer, answers from its index.

The Muse's tools are the qmd-style set in :mod:`omnigent.superchat.knowledge.tools`.
``files_ingest`` / ``files_thumbnail`` / ``files_reindex`` / ``files_find`` are never offered to a
model: the engine's relays call them (through the runner's ``/mcp/execute``) to read an
attachment before its message is sent, and to answer Nova's Library badges and citation chips.
"""

from __future__ import annotations

import asyncio
import base64
import json
import re
from typing import Any

from omnigent.runner.knowledge.db import FileRow
from omnigent.runner.knowledge.indexer import DEFAULT_K, MAX_K, AmbiguousFile
from omnigent.runner.knowledge.runtime import KnowledgeRuntime, configure, get_runtime
from omnigent.runtime.mcp_tool_result import encode_mcp_image_result
from omnigent.superchat._handler_http import HEX_ID_RE, error
from omnigent.superchat.feature import HandlerCtx
from omnigent.superchat.knowledge.tools import UPLOADS_PREFIX

#: Marks a ``files_search`` result so the transcript can show its pages as citation chips.
SEARCH_RESULT_TYPE = "file_search"
#: Search tool -> the index mode it runs in.
_SEARCH_MODES = {"files_search": "keyword", "files_vsearch": "vector", "files_query": "hybrid"}


def runtime_for(server_client: Any) -> KnowledgeRuntime:
    """The Computer's index service, started, pointed at the engine for the model proxy."""
    if server_client is not None:
        configure(str(server_client.base_url))
    runtime = get_runtime()
    runtime.start()
    return runtime


def _runtime(ctx: HandlerCtx) -> KnowledgeRuntime:
    return runtime_for(ctx.server_client)


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
    if tool_name in _SEARCH_MODES:
        return _search(runtime, tool_name, args)
    if tool_name == "files_get":
        return _get(runtime, args)
    if tool_name == "files_multi_get":
        return _multi_get(runtime, args)
    if tool_name == "files_ingest":
        return _ingest(runtime, args)
    if tool_name == "files_find":
        return _find(runtime, args)
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


def _search(runtime: KnowledgeRuntime, tool_name: str, args: dict[str, Any]) -> str:
    query = args.get("query")
    if not isinstance(query, str) or not query.strip():
        return error(f"{tool_name} requires a query")
    file_ids = args.get("file_ids")
    ids: list[str] | None = None
    if isinstance(file_ids, list) and file_ids:
        ids = [i for i in file_ids if isinstance(i, str) and HEX_ID_RE.match(i)]
        if not ids:
            return error("file_ids must be file ids from an earlier result")
    k = args.get("k")
    limit = max(1, min(k, MAX_K)) if isinstance(k, int) and not isinstance(k, bool) else DEFAULT_K
    found = runtime.indexer.search(
        query.strip(),
        mode=_SEARCH_MODES[tool_name],
        file_ids=ids,
        k=limit,
        rerank=tool_name == "files_query" and args.get("rerank") is not False,
    )
    return json.dumps({"type": SEARCH_RESULT_TYPE, **found})


def _row(runtime: KnowledgeRuntime, args: dict[str, Any], tool: str) -> FileRow | str:
    """The file a call names (path, name or file_id), or the error JSON to return."""
    file_id = args.get("file_id")
    # ``path`` takes a workspace path or a plain file name; a ``file_id`` that is no id is one too.
    path = next(
        (v for v in (args.get("path"), args.get("file_name"), args.get("file")) if v), None
    )
    if isinstance(file_id, str) and not HEX_ID_RE.match(file_id):
        path, file_id = path or file_id, None
    if isinstance(path, str) and HEX_ID_RE.match(path.strip()) and not file_id:
        path, file_id = None, path.strip()
    if not file_id and not (isinstance(path, str) and path.strip()):
        return error(f"{tool} requires the file's name or path (or a file_id)")
    try:
        row = runtime.indexer.resolve(file_id, path if isinstance(path, str) else None)
    except AmbiguousFile as exc:
        listed = ", ".join(exc.candidates)
        return error(f"More than one file matches '{exc.ref}': {listed}. Pass the full path.")
    if row is None:
        return error("That file isn't in your files index (yet)")
    return row


def _get(runtime: KnowledgeRuntime, args: dict[str, Any]) -> str:
    row = _row(runtime, args, "files_get")
    if isinstance(row, str):
        return row
    max_chars = args.get("max_chars")
    cap = max_chars if isinstance(max_chars, int) and not isinstance(max_chars, bool) else None
    indexer = runtime.indexer
    try:
        found = indexer.get(row, pages=args.get("pages"), max_chars=cap)
        if found is None:  # indexed before Markdown was kept: read it now
            indexer.ingest(row.path)
            found = indexer.get(row, pages=args.get("pages"), max_chars=cap)
    except (ValueError, OSError) as exc:
        return error(str(exc))
    if found is None:
        return error("That file has no readable text")
    return json.dumps(found)


def _multi_get(runtime: KnowledgeRuntime, args: dict[str, Any]) -> str:
    pattern = next((v for v in (args.get("glob"), args.get("pattern")) if isinstance(v, str)), "")
    if not pattern.strip():
        return error("files_multi_get requires a glob")
    max_chars = args.get("max_chars")
    cap = max_chars if isinstance(max_chars, int) and not isinstance(max_chars, bool) else None
    return json.dumps(runtime.indexer.multi_get(pattern.strip(), max_chars=cap))


def _ingest(runtime: KnowledgeRuntime, args: dict[str, Any]) -> str:
    path = args.get("path")
    if not isinstance(path, str) or not path.strip():
        return error("files_ingest requires a path")
    try:
        return json.dumps(runtime.indexer.ingest(path.strip(), within=UPLOADS_PREFIX))
    except FileNotFoundError:
        return error("That file isn't in your workspace")
    except ValueError as exc:
        return error(str(exc))


def _find(runtime: KnowledgeRuntime, args: dict[str, Any]) -> str:
    digest = args.get("sha256")
    if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", digest):
        return error("files_find requires a sha256")
    return json.dumps(runtime.indexer.find_upload(digest) or {})


def _read_page(runtime: KnowledgeRuntime, args: dict[str, Any]) -> str:
    page = _page_number(args.get("page"))
    if page is None:
        return error("files_read_page requires a page number from 1")
    row = _row(runtime, args, "files_read_page")
    if isinstance(row, str):
        return row
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
