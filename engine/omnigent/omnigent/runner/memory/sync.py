"""What feeds ``memory/``: a stored checkpoint, a Helper's Result, or a rebuild from the chats.

Every entry point here swallows its failures (logged): the files are a copy, and writing them must
never fail or delay a turn. The compaction items stay the only source; a rebuild reads them and
never reads the files back (see :mod:`omnigent.runner.memory.files`).
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx

from omnigent.context.rollover import CHECKPOINT_HEADERS, is_placeholder_summary, is_reset_item
from omnigent.entities import CompactionData
from omnigent.runner.knowledge.runtime import default_workspace
from omnigent.runner.memory import files
from omnigent.stores.conversation_store import SIDE_CHAT_LABEL_KEY, side_chat_parent_id
from omnigent.superchat.feature import is_helper
from omnigent.superchat.rollover import _get_items_page

_logger = logging.getLogger(__name__)

_COMPACTION_PAGE = "100"
_MAX_PAGES = 200


async def _snapshot(server_client: Any, chat_id: str) -> dict[str, Any]:
    """The chat's ``GET /v1/sessions/{id}`` body, or ``{}`` when it cannot be read."""
    try:
        resp = await server_client.get(f"/v1/sessions/{chat_id}", timeout=10.0)
        body = resp.json() if resp.status_code == 200 else {}
    except (httpx.HTTPError, ValueError, RuntimeError):
        return {}
    return body if isinstance(body, dict) else {}


async def _gone(server_client: Any, chat_id: str) -> bool:
    """Whether the chat no longer exists (the server answered 404). Unsure counts as present."""
    try:
        resp = await server_client.get(f"/v1/sessions/{chat_id}", timeout=10.0)
    except (httpx.HTTPError, RuntimeError):
        return False
    return resp.status_code == 404


async def _origin(server_client: Any, chat_id: str, labels: dict[str, str] | None) -> files.Origin:
    body = await _snapshot(server_client, chat_id)
    found = labels if labels is not None else body.get("labels")
    title = body.get("title")
    return files.origin_of(
        chat_id,
        found if isinstance(found, dict) else None,
        title if isinstance(title, str) else "",
    )


async def record_checkpoint(
    server_client: Any,
    chat_id: str,
    labels: dict[str, str] | None,
    item: CompactionData,
    *,
    workspace: Path | None = None,
) -> None:
    """Journal a stored checkpoint of a real chat; write ``STATE.md`` when it is the main one.

    A Helper writes nothing. Side chat and Fork seeds never come here (they are not checkpoints
    of work done). Never raises.
    """
    try:
        if is_helper(labels):
            return
        root = workspace or default_workspace()
        origin = await _origin(server_client, chat_id, labels)
        entries = files.checkpoint_lines(
            origin, item.journal_lines, item.evicted_entries, default_date=files.today()
        )
        await asyncio.to_thread(files.append_lines, root, entries)
        if origin.kind == "main":
            await asyncio.to_thread(files.write_state, root, files.state_text_of(item.summary))
        main_id = _main_id(chat_id, labels)
        if main_id:
            await asyncio.to_thread(files.write_owner, root, main_id, keep_existing=True)
    except Exception:  # noqa: BLE001 - a copy must never fail the turn
        _logger.warning("memory: could not record the checkpoint of %s", chat_id, exc_info=True)


async def record_helper_result(
    server_client: Any,
    parent_id: str,
    *,
    title: str,
    outcome: str,
    session_id: str,
    workspace: Path | None = None,
) -> None:
    """Journal one line when a Helper's Result reaches its Conversation. Never raises."""
    try:
        origin = await _origin(server_client, parent_id, None)
        entry = files.helper_result_line(
            origin, title=title, outcome=outcome, session_id=session_id, date=files.today()
        )
        await asyncio.to_thread(files.append_lines, workspace or default_workspace(), [entry])
    except Exception:  # noqa: BLE001 - a copy must never fail the turn
        _logger.warning(
            "memory: could not record a Helper result for %s", parent_id, exc_info=True
        )


async def record_daily_note(note: dict[str, Any], *, workspace: Path | None = None) -> None:
    """Project a daily note (the ``daily_note_update`` response) into its day file. Never raises.

    The note stays in the ``daily_notes`` table; the file holds a copy of its sections.
    """
    try:
        date, sections = note.get("date"), note.get("sections")
        if isinstance(date, str) and isinstance(sections, dict):
            await asyncio.to_thread(
                files.write_day_sections, workspace or default_workspace(), date, sections
            )
    except Exception:  # noqa: BLE001 - a copy must never fail the tool call
        _logger.warning("memory: could not project the daily note", exc_info=True)


async def _compaction_items(server_client: Any, chat_id: str) -> list[dict[str, Any]]:
    """Every ``compaction`` item of a chat, oldest first."""
    params = {"limit": _COMPACTION_PAGE, "order": "asc", "type": "compaction"}
    found: list[dict[str, Any]] = []
    for _ in range(_MAX_PAGES):
        page = await _get_items_page(server_client, chat_id, params)
        data = [it for it in page.get("data", []) if it.get("type") == "compaction"]
        found.extend(data)
        if not page.get("data") or not page.get("has_more", False):
            break
        params = {**params, "after": page["data"][-1]["id"]}
    return found


def _item_date(item: dict[str, Any]) -> str:
    created = item.get("created_at")
    if isinstance(created, int):
        return files.today(datetime.fromtimestamp(created, UTC))
    return files.today()


def _main_id(chat_id: str, labels: dict[str, str] | None) -> str | None:
    """The main Conversation of a chat, or ``None`` when a Side chat parent is unknown."""
    found = labels or {}
    if SIDE_CHAT_LABEL_KEY in found:
        return side_chat_parent_id(found)
    return chat_id


def _reset_entry(item: dict[str, Any], main_id: str) -> tuple[str, str]:
    return files.format_line(_item_date(item), files.RESET_TEXT, files.Origin("main", main_id))


def _is_checkpoint(item: dict[str, Any]) -> bool:
    summary = item.get("summary")
    return isinstance(summary, str) and any(summary.startswith(h) for h in CHECKPOINT_HEADERS)


async def rebuild(server_client: Any, chat_id: str, *, workspace: Path | None = None) -> None:
    """Regenerate ``memory/journal/*.md`` and ``STATE.md`` from stored checkpoints, no model call.

    Reads the compaction items of the Conversation and of its Side chats and Forks (seeds hold
    no journal lines and are not checkpoints, so they add nothing). A line already in a day file
    is not added again, so running it twice gives the same files. Helper-result lines exist only
    as notices and are not replayed. Never raises.
    """
    try:
        root = workspace or default_workspace()
        snapshot = await _snapshot(server_client, chat_id)
        labels = snapshot.get("labels")
        labels = labels if isinstance(labels, dict) else {}
        main_id = side_chat_parent_id(labels) or chat_id
        chats = [files.Origin("main", main_id)]
        resp = await server_client.get(f"/v1/sessions/{main_id}/related_chats", timeout=30.0)
        for row in resp.json().get("data", []) if resp.status_code == 200 else []:
            if isinstance(row, dict) and isinstance(row.get("id"), str):
                kind = "fork" if row.get("anchor_item_id") else "side"
                chats.append(files.Origin(kind, row["id"], row.get("title") or ""))
        entries: list[tuple[str, str]] = []
        state: str | None = None
        reset_id: str | None = None
        for origin in chats:
            items = await _compaction_items(server_client, origin.chat_id)
            for item in items:
                entries += files.checkpoint_lines(
                    origin,
                    item.get("journal_lines"),
                    item.get("evicted_entries"),
                    default_date=_item_date(item),
                )
                if origin.kind != "main":
                    continue
                if is_reset_item(item):
                    entries.append(_reset_entry(item, main_id))
                    state, reset_id = files.reset_state_text(_item_date(item)), item.get("id")
                elif not is_placeholder_summary(item.get("summary")) and _is_checkpoint(item):
                    state = files.state_text_of(item.get("summary"))
        notes = await _daily_notes(server_client)
        # Made only after the reads worked, so a failed read is retried on a later turn.
        files.memory_dir(root).mkdir(parents=True, exist_ok=True)
        await asyncio.to_thread(files.append_lines, root, entries, skip_present=True)
        if state:
            await asyncio.to_thread(files.write_state, root, state)
        for note in notes:
            await record_daily_note(note, workspace=root)
        if isinstance(reset_id, str):
            await asyncio.to_thread(files.write_last_reset, root, reset_id)
        await asyncio.to_thread(files.write_owner, root, main_id)
    except Exception:  # noqa: BLE001 - a copy must never fail the turn
        _logger.warning("memory: could not rebuild from %s", chat_id, exc_info=True)


async def _daily_notes(server_client: Any) -> list[dict[str, Any]]:
    """The owner's stored daily notes (the newest year), or ``[]`` when they cannot be read."""
    try:
        resp = await server_client.get("/v1/me/daily-notes", params={"limit": "366"}, timeout=30.0)
        rows = resp.json().get("daily_notes", []) if resp.status_code == 200 else []
    except (httpx.HTTPError, ValueError, RuntimeError, AttributeError):
        return []
    return [row for row in rows if isinstance(row, dict)]


async def _apply_reset(server_client: Any, main_id: str, root: Path) -> None:
    """Write the latest reset to the files once: a journal line, then an empty working list."""
    params = {"limit": "1", "order": "desc", "type": "compaction"}
    page = await _get_items_page(server_client, main_id, params)
    latest = next(iter(page.get("data", [])), None)
    if not isinstance(latest, dict) or not is_reset_item(latest):
        return
    item_id = latest.get("id")
    if not isinstance(item_id, str) or files.last_reset_of(root) == item_id:
        return
    ok = await asyncio.to_thread(
        files.append_lines, root, [_reset_entry(latest, main_id)], skip_present=True
    )
    state = files.reset_state_text(_item_date(latest))
    ok = ok and await asyncio.to_thread(files.write_state, root, state)
    if ok:
        await asyncio.to_thread(files.write_last_reset, root, item_id)


async def reconcile(
    server_client: Any,
    chat_id: str,
    labels: dict[str, str] | None,
    *,
    workspace: Path | None = None,
) -> None:
    """Bring ``memory/`` in line with the Conversation this turn belongs to. Never raises.

    * No folder (new or lost volume): rebuild it.
    * A folder owned by another main Conversation that was deleted: remove it, rebuild. While
      the other one still exists (or its state is unknown) the folder is left alone.
    * An unmarked folder (made before the marker): adopt it.
    * A reset the files have not seen: write it once.

    A Side chat or Fork resolves to its main Conversation, so it never counts as another one.
    When the main Conversation cannot be resolved nothing is touched.
    """
    try:
        main_id = _main_id(chat_id, labels)
        if main_id is None or is_helper(labels):
            return
        root = workspace or default_workspace()
        if not files.memory_dir(root).exists():
            await rebuild(server_client, chat_id, workspace=root)
            return
        owner = files.owner_of(root)
        if owner is not None and owner != main_id:
            if not await _gone(server_client, owner):
                return
            if await asyncio.to_thread(files.wipe, root):
                await rebuild_if_missing(server_client, chat_id, workspace=root)
            return
        if owner is None:
            await asyncio.to_thread(files.write_owner, root, main_id)
        await _apply_reset(server_client, main_id, root)
    except Exception:  # noqa: BLE001 - a copy must never fail the turn
        _logger.warning("memory: could not reconcile for %s", chat_id, exc_info=True)


async def rebuild_if_missing(
    server_client: Any, chat_id: str, *, workspace: Path | None = None
) -> None:
    """Run :func:`rebuild` when the Computer has no ``memory/`` folder (new or lost volume)."""
    root = workspace or default_workspace()
    if not files.memory_dir(root).exists():
        await rebuild(server_client, chat_id, workspace=root)
