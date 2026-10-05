"""Runner-side handler for ``side_chat_open`` (calls the server route; no in-process store)."""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any

import httpx

from omnigent.superchat.feature import HandlerCtx
from omnigent.superchat.side_chats.chats import refuse_side_chat_open


async def _execute_side_chat_open(
    args: dict[str, Any],
    *,
    server_client: httpx.AsyncClient | None,
    conversation_id: str | None,
    labels: Mapping[str, str] | None,
) -> str:
    """
    Open a Side Chat branched from the Super Chat (``side_chat_open``).

    One implementation: this calls ``POST /v1/sessions/{conversation_id}/
    side_chats`` — the same route the web app's "+ New side chat" uses —
    rather than forking / creating / binding the pieces itself. ``labels``
    (the caller's own, already in hand from the dispatch context) is used
    for a fast local pre-check only, so an obviously-ineligible caller
    (not superside-chat, or itself a Side Chat) fails without a round
    trip; the server re-checks authoritatively, including the Sub-agent
    case local ``labels`` alone can't express.

    :param args: Parsed arguments: ``title`` + ``start`` required,
        ``first_message`` optional.
    :param server_client: HTTP client pointed at the Omnigent server;
        ``None`` returns an error string.
    :param conversation_id: The caller's own session id (the would-be Super
        Chat); ``None`` returns an error string.
    :param labels: The caller's own labels, from the dispatch context.
    :returns: JSON handle ``{conversation_id, title, start}`` on success; a
        JSON error object otherwise.
    """
    if server_client is None:
        return json.dumps({"error": "side_chat_open requires server access"})
    if not conversation_id:
        return json.dumps({"error": "side_chat_open requires a session id"})

    title = args.get("title")
    if not isinstance(title, str) or not title.strip():
        return json.dumps({"error": "side_chat_open requires a non-empty 'title' string"})
    start = args.get("start")
    if start not in ("with_context", "blank"):
        return json.dumps({"error": "side_chat_open 'start' must be 'with_context' or 'blank'"})
    first_message = args.get("first_message")
    if first_message is not None and not (isinstance(first_message, str) and first_message):
        return json.dumps({"error": "side_chat_open 'first_message' must be a non-empty string"})

    # Local fast path: the two refusals ``labels`` alone can decide (not
    # superside-chat; already a Side Chat). The route re-checks everything,
    # including the Sub-agent case, which needs the caller's stored
    # ``kind`` / ``parent_session_id`` — not available here.
    refusal = refuse_side_chat_open(labels=labels, kind=None, parent_session_id=None)
    if refusal is not None:
        return json.dumps({"error": refusal})

    body: dict[str, object] = {"start": start, "title": title}
    if isinstance(first_message, str) and first_message:
        body["first_message"] = first_message
    try:
        resp = await server_client.post(f"/v1/sessions/{conversation_id}/side_chats", json=body)
    except httpx.HTTPError as exc:
        return json.dumps({"error": f"side_chat_open failed: {exc}"})
    if resp.status_code != 201:
        try:
            detail = resp.json().get("error", {}).get("message", resp.text)
        except (ValueError, AttributeError):
            detail = resp.text
        return json.dumps({"error": f"side_chat_open {start} failed: {detail}"})

    new_conv = resp.json()
    result = {
        "conversation_id": new_conv["conversation_id"],
        "title": new_conv.get("title") or title,
        "start": start,
    }
    if new_conv.get("first_message_error"):
        result["first_message_error"] = new_conv["first_message_error"]
    return json.dumps(result)


async def handle_side_chat_tool(ctx: HandlerCtx, args: dict[str, Any]) -> str:
    """Feature handler for ``side_chat_open``.

    The caller's labels are not part of :class:`HandlerCtx`; the server route re-checks
    eligibility authoritatively, so the local fast-path pre-check is skipped here only when
    labels are unavailable.
    """
    return await _execute_side_chat_open(
        args,
        server_client=ctx.server_client,
        conversation_id=ctx.conversation_id,
        labels=ctx.labels,
    )
