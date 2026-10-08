"""Runner side of ``open_project``: move the session's working directory into a Project."""

from __future__ import annotations

import json
from typing import Any

import httpx

from omnigent.superchat._handler_http import error
from omnigent.superchat.feature import HandlerCtx
from omnigent.superchat.projects.card import (
    CARD_FILE,
    is_slug,
    projects_root,
    read_card,
    workspace_root,
)


def _refusal_detail(resp: httpx.Response) -> str:
    """The server's refusal message (``{"error": {"message": ...}}``), else the raw body."""
    try:
        err = resp.json().get("error")
    except (ValueError, AttributeError):
        err = None
    detail = err.get("message") if isinstance(err, dict) else err
    return str(detail or resp.text)[:300]


async def _set_workspace(
    ctx: HandlerCtx, path: str, project_name: str | None = None
) -> str | None:
    """Ask the server to move the session's working directory; an error message on failure."""
    assert ctx.server_client is not None
    body: dict[str, Any] = {"workspace": path}
    if project_name:
        body["project_name"] = project_name
    try:
        resp = await ctx.server_client.put(
            f"/v1/sessions/{ctx.conversation_id}/workspace",
            json=body,
            timeout=30.0,
        )
    except httpx.HTTPError as exc:
        return f"could not change the working directory: {exc}"
    if resp.status_code >= 400:
        return f"could not change the working directory: {_refusal_detail(resp)}"
    return None


async def handle_open_project(ctx: HandlerCtx, args: dict[str, Any]) -> str:
    """
    Open a Project (``slug``) or return to the workspace root (``slug`` null).

    :param ctx: The call context.
    :param args: ``{"slug": str | None}``.
    :returns: A short receipt JSON, or an error JSON the model can act on.
    """
    if ctx.server_client is None or not ctx.conversation_id:
        return error("open_project requires server access")
    slug = args.get("slug")
    if slug is None:
        failure = await _set_workspace(ctx, str(workspace_root()))
        if failure:
            return error(failure)
        return json.dumps({"opened": None, "path": str(workspace_root())})
    if not is_slug(slug):
        return error("open_project: 'slug' must be a folder name from the Projects list, or null")
    folder = projects_root() / slug
    if not (folder / CARD_FILE).is_file():
        return error(f"open_project: no Project '{slug}' (it has no {CARD_FILE})")
    card = read_card(slug)
    name = card.name if card else slug
    failure = await _set_workspace(ctx, str(folder), name)
    if failure:
        return error(failure)
    return json.dumps({"opened": slug, "name": name, "path": str(folder)})
