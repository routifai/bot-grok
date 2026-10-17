"""Runner-side handlers for the artifact tools.

``artifact_save`` runs where the host's files are (the runner), reads the file from the
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
        elif tool_name == "artifact_patch":
            return await _patch(caller.client, caller.conversation_id, args)
        else:
            saver = caller.conversation_id if caller.is_helper else None
            return await _save(caller.client, chat_id, args, saver)
    except Exception as exc:  # noqa: BLE001
        return error(f"{tool_name} failed: {exc}")
    return finish(resp)


#: The engine's code for a save whose ``base_version`` is no longer the newest.
STALE_CODE = "artifact_stale"


def _error_code(resp: Any) -> str | None:
    try:
        error = resp.json().get("error")
    except (ValueError, AttributeError):
        return None
    return error.get("code") if isinstance(error, dict) else None


async def _stale(client: Any, chat_id: str, file: Path, resp: Any) -> str:
    """A stale save from a file's studio: put the newest version in the workspace, say so.

    The model re-reads the file (now the newest bytes) and redoes its change on top; nothing it
    wrote is saved over someone else's version.
    """
    from omnigent.superchat.artifacts.writeback import write_bytes_idempotent

    newest: dict[str, Any] | None = None
    try:
        listed = await client.get(f"/v1/artifacts?parent_session_id={chat_id}", timeout=30.0)
        newest = next(
            (a for a in listed.json().get("artifacts", []) if a.get("name") == file.name), None
        )
        if newest is not None:
            content = await client.get(f"/v1/artifacts/{newest['id']}/content", timeout=60.0)
            content.raise_for_status()
            await asyncio.to_thread(write_bytes_idempotent, file, content.content)
    except Exception:  # noqa: BLE001 - the refusal stands either way
        return json.dumps({"error": STALE_CODE, "details": resp.text[:500]})
    version = newest.get("version") if newest else None
    return json.dumps(
        {
            "error": STALE_CODE,
            "newest_version": version,
            "message": (
                f"{file.name} was saved as v{version} meanwhile, so yours was not saved. The "
                f"workspace file now holds v{version}: read it again, redo the change on top of "
                f"it and save with base_version {version}."
            ),
        }
    )


async def _save(client: Any, chat_id: str, args: dict[str, Any], saver: str | None) -> str:
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
    if saver:  # a Helper saves into its Conversation; the version records the Helper's turn
        url += f"&chat_id={quote(saver)}"
    base = args.get("base_version")
    if isinstance(base, int) and not isinstance(base, bool) and base >= 1:
        url += f"&base_version={base}"
    resp = await client.post(
        url, content=data, headers={"Content-Type": "application/octet-stream"}, timeout=120.0
    )
    if resp.status_code == 409 and _error_code(resp) == STALE_CODE:
        return await _stale(client, chat_id, file, resp)
    if resp.status_code >= 400:
        return finish(resp)
    saved = resp.json()
    # source_path lets the file search follow a saved file (knowledge's on_result listener).
    return json.dumps({"type": "artifact", **saved, "source_path": str(file)})


async def _patch(client: Any, studio_id: str, args: dict[str, Any]) -> str:
    """``artifact_patch`` from a file's studio: patch the newest version, mirror it on disk.

    The saved bytes are written to the file's workspace path, so a later read or
    ``artifact_save`` of the file starts from them. A stale base says which version is newest.
    """
    from omnigent.superchat.artifacts.writeback import write_bytes_idempotent

    artifact_id = args.get("artifact_id")
    base = args.get("base_version")
    patches = args.get("patches")
    if not isinstance(artifact_id, str) or not HEX_ID_RE.match(artifact_id):
        return error("artifact_patch requires the file's artifact_id (its group id)")
    if not isinstance(base, int) or isinstance(base, bool) or base < 1:
        return error("artifact_patch requires base_version: the version you are changing")
    if not isinstance(patches, list) or not patches:
        return error("artifact_patch requires at least one patch")
    resp = await client.post(
        f"/v1/artifacts/{artifact_id}/patch",
        json={"chat_id": studio_id, "base_version": base, "patches": patches},
        timeout=60.0,
    )
    if resp.status_code == 409 and _error_code(resp) == STALE_CODE:
        newest: int | None = None
        try:
            detail = await client.get(f"/v1/artifacts/{artifact_id}", timeout=30.0)
            versions = detail.json().get("all_versions") or []
            newest = versions[0].get("version") if versions else None
        except Exception:  # noqa: BLE001 - the refusal stands either way
            newest = None
        return json.dumps(
            {
                "error": STALE_CODE,
                "newest_version": newest,
                "message": (
                    f"The file was saved as v{newest} meanwhile, so nothing was changed. Read it "
                    f"again and redo the change with base_version {newest}."
                ),
            }
        )
    if resp.status_code >= 400:
        return finish(resp)
    saved = resp.json()
    source = saved.get("source_path")
    if isinstance(source, str) and source and saved.get("summary"):
        file = resolve_workspace_file(source, workspace_roots())
        if isinstance(file, Path):
            try:
                content = await client.get(f"/v1/artifacts/{saved['id']}/content", timeout=60.0)
                content.raise_for_status()
                await asyncio.to_thread(write_bytes_idempotent, file, content.content)
            except Exception:  # noqa: BLE001 - the version is saved; the next read refreshes
                pass
    return json.dumps({"type": "artifact", **saved})
