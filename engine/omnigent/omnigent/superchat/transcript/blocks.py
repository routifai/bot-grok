"""Project a session's raw items into the typed blocks a chat renders.

Pure: items in (the flat ``ConversationItem.to_api_dict()`` shape, oldest first), messages
out. The rules a client would otherwise copy:

* a message item is a ``text`` block; the runtime's own notices and hidden context are dropped;
* ``render_card`` / ``ask_clarification`` / ``suggest_follow_ups`` / ``vault_request_secret`` /
  ``artifact_save`` / ``deck_export`` / ``display_chart`` calls become
  ``card`` / ``secure_entry`` / ``file`` messages of their own (a call whose output says it
  failed shows nothing; a card still running is ``pending``);
* a delivered file (a ``resource_event`` whose ``resource_type`` is ``artifact``: something the
  person did, such as exporting a deck from the panel) becomes a ``file`` message marked
  ``"by": "user"``; it is not a tool call, and the Muse's history never replays it;
* a ``start_helper`` call becomes a ``helper`` block under the next assistant message;
* the pages a ``files_search`` / ``files_vsearch`` / ``files_query`` call found become one
  ``passages`` card (citation chips) under the next assistant message;
* a turn shows one assistant text: its last. Text the Muse wrote between tool calls earlier in
  the same turn (a user message starts a turn) is interim narration and is not a message; the
  Helper rows and citation chips it would have carried move to the turn's last text;
* one ``call_id`` is one block, however often the call repeats;
* an ``error`` item is an ``error`` block carrying its code, never its text; the code is read
  through ``public_error_code`` so legacy rows (exception names, old codes) show the closed set.

Wording stays with the client: nothing here is copy.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any

from omnigent.context.attachments import strip_legacy_attachment_context
from omnigent.entities.conversation import is_system_notice_text
from omnigent.runtime.public_error_codes import public_error_code
from omnigent.superchat.artifact_kinds import KIND_MIME
from omnigent.superchat.cards.tools import (
    CARD_TOOL_NAME,
    CLARIFICATION_TOOL_NAME,
    FOLLOW_UPS_TOOL_NAME,
)
from omnigent.superchat.helpers.tools import START_HELPER_TOOL_NAME

VAULT_REQUEST_TOOL_NAME = "vault_request_secret"
ARTIFACT_SAVE_TOOL_NAME = "artifact_save"
#: Returns the same ``{"type": "artifact", ...}`` result, so its file shows as the same card.
DECK_EXPORT_TOOL_NAME = "deck_export"
#: Also returns the ``{"type": "artifact", ...}`` result: the saved chart shows as a file card.
#: The tool is retired; the name stays so older conversations keep their charts.
CHART_TOOL_NAME = "display_chart"
#: Same result for a dashboard: one file card for the whole dashboard.
DASHBOARD_TOOL_NAME = "display_dashboard"
#: The calls whose ``{"type": "artifact", ...}`` result shows as a file card.
FILE_RESULT_TOOL_NAMES = (
    ARTIFACT_SAVE_TOOL_NAME,
    DECK_EXPORT_TOOL_NAME,
    CHART_TOOL_NAME,
    DASHBOARD_TOOL_NAME,
)

#: ``ResourceEventData`` fields of a file a person's own action delivered into the chat.
DELIVERED_ARTIFACT_RESOURCE = "artifact"
DELIVERED_EVENT = "session.resource.created"
FILES_SEARCH_TOOL_NAMES = ("files_search", "files_vsearch", "files_query")
#: Most pages shown as citation chips under one answer.
_MAX_CITATIONS = 6

Item = Mapping[str, Any]


def _is_call(item: Item, tool: str) -> bool:
    """Whether *item* calls *tool*, bare or behind a harness prefix (``mcp__omnigent__...``)."""
    name = item.get("name")
    return (
        item.get("type") == "function_call"
        and isinstance(name, str)
        and (name == tool or name.endswith(f"__{tool}"))
    )


def _object(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, str):
        return None
    try:
        value = json.loads(raw)
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def tool_outputs_by_call_id(items: list[Item]) -> dict[str, str]:
    """``call_id`` -> output text of every ``function_call_output`` in *items*."""
    return {
        item["call_id"]: item["output"] if isinstance(item.get("output"), str) else ""
        for item in items
        if item.get("type") == "function_call_output" and isinstance(item.get("call_id"), str)
    }


def item_text(item: Item) -> str:
    """The text of a message item's ``input_text`` / ``output_text`` parts, joined and trimmed.

    A user message stored by an older gateway carried the attached files' text in an
    ``<attachment_context>`` block; that is document data, not the person's words, so it is cut.
    """
    content = item.get("content")
    parts = [
        block["text"]
        for block in (content if isinstance(content, list) else [])
        if isinstance(block, dict)
        and block.get("type") in ("output_text", "input_text")
        and isinstance(block.get("text"), str)
    ]
    text = "\n\n".join(parts).strip()
    return strip_legacy_attachment_context(text) if item.get("role") == "user" else text


def _card_payload(payload: Mapping[str, Any]) -> dict[str, Any] | None:
    card, fallback, data = payload.get("card"), payload.get("fallback"), payload.get("data")
    if not isinstance(card, str) or not isinstance(fallback, str) or not fallback.strip():
        return None
    if not isinstance(data, dict):
        return None
    out: dict[str, Any] = {"card": card}
    for key in ("id", "title"):
        if isinstance(payload.get(key), str) and payload[key]:
            out[key] = payload[key]
    out["data"] = data
    out["fallback"] = fallback.strip()
    return out


def _card_block(call: Item, output: str | None) -> dict[str, Any] | None:
    """The ``card`` block of a ``render_card`` call; pending while it has no output."""
    pending = output is None
    if pending:
        args = _object(call.get("arguments"))
        payload = _card_payload({**args, "data": {}}) if args else None
    else:
        result = _object(output)
        payload = _card_payload(result) if result and result.get("type") == "card" else None
    if payload is None:
        return None
    return {
        "type": "card",
        "card_id": payload.get("id"),
        "card": payload,
        **({"pending": True} if pending else {}),
    }


def _secure_entry_block(output: str | None) -> dict[str, Any] | None:
    result = _object(output)
    nested = result.get("secure_entry") if result else None
    if not isinstance(nested, dict):
        return None
    request_id, name, site = nested.get("id"), nested.get("name"), nested.get("site")
    if not (isinstance(request_id, str) and isinstance(name, str) and isinstance(site, str)):
        return None
    reason = nested.get("reason")
    return {
        "type": "secure_entry",
        "request_id": request_id,
        "name": name,
        "site": site,
        **({"reason": reason} if isinstance(reason, str) else {}),
    }


def _file_block(output: str | None) -> dict[str, Any] | None:
    return _file_block_of(_object(output))


def _delivered_file_block(item: Item) -> dict[str, Any] | None:
    """The ``file`` block of a file the person's own action delivered, marked ``by: user``."""
    if (
        item.get("event_type") != DELIVERED_EVENT
        or item.get("resource_type") != DELIVERED_ARTIFACT_RESOURCE
    ):
        return None
    block = _file_block_of(item.get("resource"))
    return {**block, "by": "user"} if block else None


def _file_block_of(saved: Any) -> dict[str, Any] | None:
    if not isinstance(saved, dict) or saved.get("type") != "artifact":
        return None
    artifact_id, name = saved.get("id"), saved.get("name")
    if not isinstance(artifact_id, str) or not isinstance(name, str):
        return None
    kind = saved.get("kind")
    block: dict[str, Any] = {
        "type": "file",
        "artifact_id": artifact_id,
        "name": name,
        "mime": KIND_MIME.get(kind) if isinstance(kind, str) else None,
    }
    if isinstance(saved.get("title"), str) and saved["title"]:
        block["title"] = saved["title"]
    for key in ("kind", "size", "version", "versions"):
        if saved.get(key) is not None:
            block[key] = saved[key]
    return block


def _citations(output: str | None) -> list[dict[str, Any]]:
    """The distinct file pages a ``files_search`` result found, best first."""
    result = _object(output)
    if not result or result.get("type") != "file_search":
        return []
    found: list[dict[str, Any]] = []
    for hit in result.get("results") if isinstance(result.get("results"), list) else []:
        if not isinstance(hit, dict):
            continue
        file_id, name, page = hit.get("file_id"), hit.get("file_name"), hit.get("page")
        if not (isinstance(file_id, str) and isinstance(name, str) and isinstance(page, int)):
            continue
        artifact_id, path = hit.get("artifact_id"), hit.get("path")
        found.append(
            {
                "fileId": file_id,
                **({"artifactId": artifact_id} if isinstance(artifact_id, str) else {}),
                **({"path": path} if isinstance(path, str) and path else {}),
                "name": name,
                "page": page,
                **({"hasThumbnail": True} if hit.get("thumbnail_url") else {}),
            }
        )
    return found


def _citation_block(items: list[dict[str, Any]]) -> dict[str, Any] | None:
    """One ``card`` block of citation chips for the pages searched this turn."""
    unique = list({(i["fileId"], i["page"]): i for i in items}.values())[:_MAX_CITATIONS]
    if not unique:
        return None
    label = ", ".join(f"{i['name']} p. {i['page']}" for i in unique)
    return {
        "type": "card",
        "card_id": None,
        "card": {
            "card": "passages",
            "data": {"items": unique},
            "fallback": f"Sources: {label}",
        },
    }


def _helper_block(
    call_id: str, output: str | None, statuses: Mapping[str, str]
) -> dict[str, Any] | None:
    """A started Helper; a refused or still-running call has none to show."""
    receipt = _object(output)
    if not receipt or receipt.get("started") is not True:
        return None
    session_id = receipt.get("helper_id")
    if not isinstance(session_id, str) or not session_id:
        return None
    title = receipt.get("title")
    return {
        "type": "helper",
        "call_id": call_id,
        "session_id": session_id,
        "title": title if isinstance(title, str) else "",
        "status": statuses.get(session_id, "unknown"),
    }


def helper_session_ids(items: list[Item]) -> list[str]:
    """The Helper sessions *items* started, so a caller can look their status up."""
    outputs = tool_outputs_by_call_id(items)
    found: list[str] = []
    for item in items:
        if _is_call(item, START_HELPER_TOOL_NAME):
            receipt = _object(outputs.get(str(item.get("call_id") or "")))
            if receipt and receipt.get("started") is True:
                helper_id = receipt.get("helper_id")
                if isinstance(helper_id, str) and helper_id:
                    found.append(helper_id)
    return found


def _message(item: Item, role: str, blocks: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "id": item["id"],
        "role": role,
        "created_at": item.get("created_at"),
        "blocks": blocks,
    }


_TURN_ENDING_CARD_TOOLS = (CLARIFICATION_TOOL_NAME, FOLLOW_UPS_TOOL_NAME)


def _final_text_ids(items: list[Item], outputs: Mapping[str, str]) -> set[str]:
    """Ids of the assistant text items that end their turn (a user message starts a turn).

    A turn that shows an ``ask_clarification`` or ``suggest_follow_ups`` card ends there: the
    card belongs to the answer written before it, so text the model adds after the card is
    dropped instead of replacing the answer (and pushing the chips off the last message).
    """
    final: dict[int, str] = {}
    closed: set[int] = set()
    turn = 0
    for item in items:
        if item.get("type") == "function_call":
            if any(_is_call(item, name) for name in _TURN_ENDING_CARD_TOOLS):
                result = _object(outputs.get(str(item.get("call_id") or "")))
                if result and result.get("type") == "card":
                    closed.add(turn)
            continue
        if item.get("type") != "message" or item.get("is_meta") is True:
            continue
        if item.get("role") == "user":
            turn += 1
        elif (
            item.get("role") == "assistant"
            and turn not in closed
            and item_text(item)
            and "id" in item
        ):
            final[turn] = item["id"]
    return set(final.values())


def project_items(
    items: list[Item], *, helper_statuses: Mapping[str, str] | None = None
) -> list[dict[str, Any]]:
    """Turn *items* (oldest first) into transcript messages.

    :param items: ``ConversationItem.to_api_dict()`` dicts in ascending order.
    :param helper_statuses: Helper session id -> status, for the ``helper`` blocks.
    :returns: ``[{"id", "role", "created_at", "blocks"}, ...]``.
    """
    statuses = helper_statuses or {}
    outputs = tool_outputs_by_call_id(items)
    messages: list[dict[str, Any]] = []
    helpers: list[dict[str, Any]] = []
    cited: list[dict[str, Any]] = []
    seen_calls: set[str] = set()
    final_text = _final_text_ids(items, outputs)
    for item in items:
        kind = item.get("type")
        if kind == "function_call":
            call_id = str(item.get("call_id") or "")
            if call_id and call_id in seen_calls:
                continue
            if call_id:
                seen_calls.add(call_id)
            output = outputs.get(call_id)
            block: dict[str, Any] | None = None
            if _is_call(item, START_HELPER_TOOL_NAME):
                helper = _helper_block(call_id, output, statuses)
                if helper:
                    helpers.append(helper)
                continue
            if any(_is_call(item, name) for name in FILES_SEARCH_TOOL_NAMES):
                cited.extend(_citations(output))
                continue
            if _is_call(item, CARD_TOOL_NAME):
                block = _card_block(item, output)
            elif _is_call(item, CLARIFICATION_TOOL_NAME) or _is_call(item, FOLLOW_UPS_TOOL_NAME):
                # Instant tools: the card appears with its result, never as a skeleton.
                block = _card_block(item, output) if output is not None else None
            elif _is_call(item, VAULT_REQUEST_TOOL_NAME):
                block = _secure_entry_block(output)
            elif any(_is_call(item, name) for name in FILE_RESULT_TOOL_NAMES):
                block = _file_block(output)
            if block:
                messages.append(_message(item, "assistant", [block]))
        elif kind == "resource_event":
            delivered = _delivered_file_block(item)
            if delivered:
                messages.append(_message(item, "assistant", [delivered]))
        elif kind == "error":
            code = item.get("code")
            if isinstance(code, str) and code:
                block = {"type": "error", "code": public_error_code(code)}
                if item.get("level") == "info":
                    block["level"] = "info"
                messages.append(_message(item, "assistant", [block]))
        elif kind == "message":
            role = item.get("role")
            if role not in ("user", "assistant") or item.get("is_meta") is True:
                continue
            text = item_text(item)
            if not text:
                continue
            if role == "user" and (
                item.get("is_system_notice") is True or is_system_notice_text(text)
            ):
                continue
            if role == "assistant" and item.get("id") not in final_text:
                continue  # interim narration: the turn's last text is its reply
            blocks: list[dict[str, Any]] = [{"type": "text", "text": text}]
            if role == "user":
                cited = []
            if role == "assistant" and helpers:
                blocks.extend(helpers)
                helpers = []
            if role == "assistant" and cited:
                citations = _citation_block(cited)
                if citations:
                    blocks.append(citations)
                cited = []
            messages.append(_message(item, role, blocks))
    return messages
