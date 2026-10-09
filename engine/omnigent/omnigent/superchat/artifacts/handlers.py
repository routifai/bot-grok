"""Runner-side handlers for the artifact tools.

``artifact_save`` runs where the Computer's files are (the runner), reads the file from the
workspace and uploads it to the server; list/delete proxy the REST endpoints.
"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Any
from urllib.parse import quote

from omnigent.superchat._handler_http import HEX_ID_RE, error, finish, resolve_caller
from omnigent.superchat.artifact_kinds import KIND_MIME, MAX_ARTIFACT_BYTES, kind_for_name
from omnigent.superchat.feature import HandlerCtx


def workspace_roots() -> list[Path]:
    """Directories a save may read from: the runner workspace, ``~/workspace`` and the cwd."""
    candidates = [os.environ.get("OMNIGENT_RUNNER_WORKSPACE"), str(Path.home() / "workspace")]
    roots = [Path(c) for c in candidates if c]
    roots.append(Path.cwd())
    resolved: list[Path] = []
    for root in roots:
        try:
            real = root.resolve()
        except OSError:
            continue
        if real.is_dir() and real not in resolved:
            resolved.append(real)
    return resolved


def resolve_workspace_file(raw: str, roots: list[Path]) -> Path | str:
    """The real file for ``raw`` when it lies under a workspace root, else an error string."""
    given = Path(raw).expanduser()
    options = [given] if given.is_absolute() else [root / given for root in roots]
    for option in options:
        try:
            real = option.resolve()
        except OSError:
            continue
        if any(real.is_relative_to(root) for root in roots):
            if real.is_file():
                return real
            continue
    if any(o.exists() for o in options):
        return "path must be a file inside your workspace"
    return f"file not found: {raw}"


def _read(path: Path) -> bytes | str:
    size = path.stat().st_size
    if size == 0:
        return "file is empty"
    if size > MAX_ARTIFACT_BYTES:
        return f"file too large ({size // (1024 * 1024)} MB; 25 MB max)"
    return path.read_bytes()


async def handle_artifact_tool(ctx: HandlerCtx, args: dict[str, Any]) -> str:
    """
    Run one artifact tool.

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
        if tool_name == "artifact_list":
            resp = await caller.client.get(
                f"/v1/artifacts?parent_session_id={chat_id}", timeout=30.0
            )
        elif tool_name == "artifact_delete":
            artifact_id = args.get("artifact_id")
            if not isinstance(artifact_id, str) or not HEX_ID_RE.match(artifact_id):
                return error("artifact_delete requires a valid artifact_id")
            resp = await caller.client.delete(f"/v1/artifacts/{artifact_id}", timeout=30.0)
        else:
            return await _save(caller.client, chat_id, args)
    except Exception as exc:  # noqa: BLE001
        return error(f"{tool_name} failed: {exc}")
    return finish(resp)


async def _save(client: Any, chat_id: str, args: dict[str, Any]) -> str:
    raw = args.get("path")
    if not isinstance(raw, str) or not raw.strip():
        return error("artifact_save requires a path")
    file = resolve_workspace_file(raw.strip(), workspace_roots())
    if isinstance(file, str):
        return error(file)
    if kind_for_name(file.name) is None:
        return error(f"file type not allowed; use one of: {', '.join(KIND_MIME)}")
    data = await asyncio.to_thread(_read, file)
    if isinstance(data, str):
        return error(data)
    title = args.get("title")
    url = (
        f"/v1/artifacts?parent_session_id={chat_id}&name={quote(file.name)}"
        f"&source_path={quote(str(file))}"
    )
    if isinstance(title, str) and title.strip():
        url += f"&title={quote(title.strip()[:256])}"
    resp = await client.post(
        url, content=data, headers={"Content-Type": "application/octet-stream"}, timeout=120.0
    )
    if resp.status_code >= 400:
        return finish(resp)
    saved = resp.json()
    return json.dumps({"type": "artifact", **saved})
