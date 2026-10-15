"""What feeds ``memory/``: a stored checkpoint, a Helper's Result, or a rebuild from the chats.

Also what feeds the index's ``conversation`` source: the passages of the turns a checkpoint
retires (:func:`index_retired_turns`), the turns an archived Side chat or Fork still held in
context (:func:`index_archived_chats`), the turns from before that (:func:`backfill_turns`), and
their removal with a deleted Conversation (:func:`reconcile`). A turn of the current epoch is
still in context, so it is not a passage until the compaction that retires it.

Every entry point here swallows its failures (logged): the files are a copy, and writing them must
never fail or delay a turn. The compaction items stay the only source; a rebuild reads them and
never reads the files back (see :mod:`omnigent.runner.memory.files`).
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx

from omnigent.context.rollover import CHECKPOINT_HEADERS, is_placeholder_summary, is_reset_item
from omnigent.entities import CompactionData
from omnigent.runner.knowledge.db import TurnPassage
from omnigent.runner.knowledge.runtime import KnowledgeRuntime, default_workspace
from omnigent.runner.knowledge.turns import Turn, passage_of, split_turns
from omnigent.runner.memory import files
from omnigent.stores.conversation_store import SIDE_CHAT_LABEL_KEY, side_chat_parent_id
from omnigent.superchat.feature import is_helper
from omnigent.superchat.projects.card import project_slug_from_workspace
from omnigent.superchat.rollover import (
    ItemsPageFetchError,
    _get_items_page,
    fetch_latest_checkpoint,
    iter_items_from_checkpoint,
)

_logger = logging.getLogger(__name__)

_COMPACTION_PAGE = "100"
_MAX_PAGES = 200

#: One backfill run reads at most this many pages (the route's maximum each) and writes at most
#: this many turns, so an old Conversation is indexed over a few turns, none of them slowed.
_BACKFILL_PAGE = "1000"
_BACKFILL_PAGES = 5
_BACKFILL_TURNS = 300
#: Index meta keys: the last item a chat's backfill read, and a main Conversation it finished.
#: Versioned: bumped when what a passage holds changes, so the backfill writes it once again.
CURSOR_KEY = "turns_cursor.v3:"
BACKFILLED_KEY = "turns_backfilled.v3:"
#: Index meta key: the ``updated_at`` of an archived chat whose last turns were written.
ARCHIVED_KEY = "turns_archived:"
#: How often one process looks for newly archived chats of a Conversation (auto-archive is
#: hourly).
_ARCHIVE_CHECK_SECONDS = 600.0
_archive_checked: dict[str, float] = {}


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
            origin,
            item.journal_lines,
            item.evicted_entries,
            default_date=files.today(),
            refs=item.journal_refs,
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
    """Journal one line when a Helper's Result reaches its Conversation. Never raises.

    The line names the Helper and, when its working directory is in one, the Project.
    """
    try:
        origin = await _origin(server_client, parent_id, None)
        workspace_dir = (await _snapshot(server_client, session_id)).get("workspace")
        entry = files.helper_result_line(
            origin,
            title=title,
            outcome=outcome,
            session_id=session_id,
            date=files.today(),
            project=project_slug_from_workspace(
                workspace_dir if isinstance(workspace_dir, str) else None
            ),
        )
        await asyncio.to_thread(files.append_lines, workspace or default_workspace(), [entry])
    except Exception:  # noqa: BLE001 - a copy must never fail the turn
        _logger.warning(
            "memory: could not record a Helper result for %s", parent_id, exc_info=True
        )


async def record_hand_edits(
    server_client: Any,
    chat_id: str,
    edits: list[dict[str, Any]],
    *,
    workspace: Path | None = None,
) -> None:
    """Journal one line per hand-edited artifact version delivered to a turn. Never raises.

    *edits* are ``pending-edits`` rows; only ``origin == "manual"`` ones are the person's (a live
    update's refresh is not). A Helper writes nothing.
    """
    try:
        manual = [e for e in edits if e.get("origin") == "manual"]
        if not manual:
            return
        body = await _snapshot(server_client, chat_id)
        labels = body.get("labels") if isinstance(body.get("labels"), dict) else None
        if is_helper(labels):
            return
        title = body.get("title")
        origin = files.origin_of(chat_id, labels, title if isinstance(title, str) else "")
        entries = [
            files.hand_edit_line(
                origin,
                name=str(edit["name"]),
                version=int(edit["version"]),
                artifact_id=str(edit["id"]),
                summary=str(edit.get("edit_summary") or ""),
                date=_item_date(edit),
            )
            for edit in manual
        ]
        await asyncio.to_thread(files.append_lines, workspace or default_workspace(), entries)
    except Exception:  # noqa: BLE001 - a copy must never fail the turn
        _logger.warning("memory: could not record the hand edits in %s", chat_id, exc_info=True)


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


async def _related_rows(server_client: Any, main_id: str) -> list[dict[str, Any]] | None:
    """The ``related_chats`` rows of a main Conversation, or ``None`` when they cannot be read."""
    resp = await server_client.get(f"/v1/sessions/{main_id}/related_chats", timeout=30.0)
    if resp.status_code != 200:
        return None
    rows = resp.json().get("data", [])
    return [row for row in rows if isinstance(row, dict) and isinstance(row.get("id"), str)]


def _row_origin(row: dict[str, Any]) -> files.Origin:
    kind = "fork" if row.get("anchor_item_id") else "side"
    return files.Origin(kind, row["id"], row.get("title") or "")


async def _related_chats(server_client: Any, main_id: str) -> list[files.Origin] | None:
    """The Side chats and Forks of a main Conversation, or ``None`` when they cannot be read."""
    rows = await _related_rows(server_client, main_id)
    return None if rows is None else [_row_origin(row) for row in rows]


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
        related = await _related_chats(server_client, main_id) or []
        chats = [files.Origin("main", main_id), *related]
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
                    refs=item.get("journal_refs"),
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
    runtime: KnowledgeRuntime | None = None,
) -> None:
    """Bring ``memory/`` in line with the Conversation this turn belongs to. Never raises.

    * No folder (new or lost volume): rebuild it.
    * A folder owned by another main Conversation that was deleted: remove it, rebuild. While
      the other one still exists (or its state is unknown) the folder is left alone. The deleted
      Conversation's passages (its Side chats' and Forks' too) leave the index with it.
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
                await _forget_conversation(server_client, owner, runtime)
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


# ── the index's conversation source ──────────────────────────────────────


def _knowledge(server_client: Any, runtime: KnowledgeRuntime | None) -> KnowledgeRuntime | None:
    """The Computer's index service, or ``None`` outside a managed Computer (nothing to write)."""
    if runtime is not None:
        return runtime
    if os.environ.get("IS_SANDBOX") != "1":
        return None
    from omnigent.runner.knowledge import runtime as service

    base_url = getattr(server_client, "base_url", None)
    service.configure(str(base_url) if base_url else None)
    found = service.get_runtime()
    found.start()
    return found


def _passages(
    turns: list[Turn], origin: files.Origin, main_id: str, project: str = ""
) -> list[TurnPassage]:
    """The passages of *turns*; a turn a runtime notice started is never one, and its items count
    as the previous passage's (so an anchor at its end still finds a turn)."""
    out: list[TurnPassage] = []
    for t in turns:
        if t.notice:
            if out:
                out[-1] = replace(out[-1], last_item_id=t.last_item_id)
            continue
        out.append(
            passage_of(
                t, chat_id=origin.chat_id, main_id=main_id, origin=origin.kind, project=project
            )
        )
    return out


async def index_retired_turns(
    server_client: Any,
    chat_id: str,
    labels: dict[str, str] | None,
    window: list[dict[str, Any]],
    *,
    project: str = "",
    runtime: KnowledgeRuntime | None = None,
) -> None:
    """Write the turns a stored checkpoint retired to the index, in one batch. Never raises.

    *window* is the record the checkpoint summarized (the items after the previous anchor, up to
    its own), already read by the rollover: nothing is read again. Called once the compaction
    item is stored, for the main Conversation, a Side chat or a Fork alike. *project* is the
    Project folder the chat runs in. A Helper's turns, steers and runtime notices are never
    passages (:mod:`.turns`).
    """
    try:
        main_id = _main_id(chat_id, labels)
        found = _knowledge(server_client, runtime)
        if main_id is None or is_helper(labels) or found is None:
            return
        origin = files.origin_of(chat_id, labels)
        passages = _passages(split_turns(window), origin, main_id, project)
        if passages:
            await asyncio.to_thread(found.indexer.index_turns, passages)
    except Exception:  # noqa: BLE001 - indexing must never fail the turn
        _logger.warning("recall: could not index the retired turns of %s", chat_id, exc_info=True)


async def index_archived_chats(
    server_client: Any,
    chat_id: str,
    labels: dict[str, str] | None,
    *,
    runtime: KnowledgeRuntime | None = None,
) -> None:
    """Index the turns an archived Side chat or Fork held past its last checkpoint. Never raises.

    No compaction retires them: the chat stopped. Each archived chat of the Conversation is read
    from its last anchor once per archive (its ``updated_at`` then is kept); a chat unarchived
    and archived again is read again. Looked up at most every :data:`_ARCHIVE_CHECK_SECONDS` per
    Conversation.
    """
    try:
        main_id = _main_id(chat_id, labels)
        found = _knowledge(server_client, runtime)
        if main_id is None or is_helper(labels) or found is None:
            return
        now = time.monotonic()
        last = _archive_checked.get(main_id)
        if last is not None and now - last < _ARCHIVE_CHECK_SECONDS:
            return
        _archive_checked[main_id] = now
        db = found.indexer.db
        for row in await _related_rows(server_client, main_id) or []:
            key, mark = f"{ARCHIVED_KEY}{row['id']}", str(row.get("updated_at"))
            if not row.get("archived") or await asyncio.to_thread(db.meta, key) == mark:
                continue
            items: list[dict[str, Any]] = []
            async for page in iter_items_from_checkpoint(
                server_client, row["id"], skip_placeholders=True
            ):
                items.extend(page)
            passages = _passages(split_turns(items), _row_origin(row), main_id)
            await asyncio.to_thread(found.indexer.index_turns, passages, cursor=(key, mark))
    except Exception:  # noqa: BLE001 - indexing must never fail the turn
        _logger.warning("recall: could not index the archived chats of %s", chat_id, exc_info=True)


def _backfill_step(
    items: list[dict[str, Any]], more: bool, room: int, ends: set[str]
) -> tuple[list[Turn], str | None, bool]:
    """What one page of the record gives: ``(turns to write, new cursor, reached the end)``.

    *ends* are the chat's latest checkpoint anchor and the checkpoint item itself: the record
    up to the first of them is retired, every turn in it complete. Before it, the page's last
    turn may go on in the next page, so it is left for the next read; a single turn longer than
    a page is taken whole. Past it is the current epoch, which only its compaction indexes.
    ``None`` as the cursor means no progress.
    """
    end = next((i for i, it in enumerate(items) if it.get("id") in ends), None)
    if end is not None:
        items = items[: end + 1]
        turns = split_turns(items)
        keep, cut, done = turns, len(items), True
    elif not more:
        return [], None, True  # the cursor is at or past the anchor: nothing retired is left
    else:
        turns = split_turns(items)
        keep, cut, done = turns[:-1], (turns[-1].first if turns else len(items)), False
        if not keep and cut == 0:
            keep, cut = turns, len(items)
    if len(keep) > room:
        keep, cut, done = keep[:room], turns[room].first, False
    cursor = items[cut - 1].get("id") if cut > 0 else None
    return keep, cursor if isinstance(cursor, str) else None, done


async def _backfill_chat(
    server_client: Any,
    found: KnowledgeRuntime,
    origin: files.Origin,
    main_id: str,
    budget: dict[str, int],
) -> bool:
    """Index a chat's retired turns (up to its latest checkpoint's anchor) from its saved cursor
    while *budget* lasts. ``True`` once none is left; a chat never compacted has none."""
    db, key = found.indexer.db, f"{CURSOR_KEY}{origin.chat_id}"
    checkpoint = await fetch_latest_checkpoint(
        server_client, origin.chat_id, skip_placeholders=True
    )
    if checkpoint is None:
        return True
    ends = {e for e in (checkpoint.get("last_item_id"), checkpoint.get("id")) if e}
    while budget["pages"] > 0 and budget["turns"] > 0:
        cursor = await asyncio.to_thread(db.meta, key)
        if cursor in ends:
            return True
        params = {"limit": _BACKFILL_PAGE, "order": "asc", **({"after": cursor} if cursor else {})}
        try:
            page = await _get_items_page(server_client, origin.chat_id, params)
        except ItemsPageFetchError as exc:
            if exc.status_code == 400 and cursor:
                # A cursor item that is gone: read again from the start (writes are idempotent).
                await asyncio.to_thread(db.set_meta, key, None)
            raise
        budget["pages"] -= 1
        items = [it for it in page.get("data", []) if isinstance(it, dict)]
        more = bool(items) and bool(page.get("has_more", False))
        turns, moved, ended = _backfill_step(items, more, budget["turns"], ends)
        budget["turns"] -= len(turns)
        passages = _passages(turns, origin, main_id)
        await asyncio.to_thread(
            found.indexer.index_turns, passages, cursor=(key, moved) if moved else None
        )
        if ended:
            return True
    return False


async def backfill_turns(
    server_client: Any,
    chat_id: str,
    labels: dict[str, str] | None,
    *,
    runtime: KnowledgeRuntime | None = None,
) -> None:
    """Index, once, the turns a Conversation had before turns were indexed. Never raises.

    Reads the record of the main Conversation, then of each Side chat and Fork, from its first
    item to its latest checkpoint's anchor (every retired turn, none of the current epoch), at
    most :data:`_BACKFILL_PAGES` pages and :data:`_BACKFILL_TURNS` turns per run. Each chat's
    progress (the last item read) is saved with its passages, so a restart resumes where it
    stopped and never writes a turn twice. Once every chat was read to its anchor the
    Conversation is marked done; from then on its turns arrive with each compaction.
    """
    try:
        main_id = _main_id(chat_id, labels)
        found = _knowledge(server_client, runtime)
        if main_id is None or is_helper(labels) or found is None:
            return
        db = found.indexer.db
        if await asyncio.to_thread(db.meta, f"{BACKFILLED_KEY}{main_id}"):
            return
        related = await _related_chats(server_client, main_id)
        done = related is not None
        budget = {"pages": _BACKFILL_PAGES, "turns": _BACKFILL_TURNS}
        for origin in [files.Origin("main", main_id), *(related or [])]:
            if not await _backfill_chat(server_client, found, origin, main_id, budget):
                done = False
                break
        if done:
            await asyncio.to_thread(db.set_meta, f"{BACKFILLED_KEY}{main_id}", "done")
    except Exception:  # noqa: BLE001 - indexing must never fail the turn
        _logger.warning("recall: could not backfill the turns of %s", chat_id, exc_info=True)


async def _forget_conversation(
    server_client: Any, main_id: str, runtime: KnowledgeRuntime | None
) -> None:
    """Remove a deleted Conversation's passages, its Side chats' and Forks' too, from the index."""
    try:
        found = _knowledge(server_client, runtime)
        if found is None:
            return
        chats = [main_id, *await asyncio.to_thread(found.indexer.db.chats_of, main_id)]
        keys = [
            f"{BACKFILLED_KEY}{main_id}",
            *(f"{prefix}{chat}" for chat in chats for prefix in (CURSOR_KEY, ARCHIVED_KEY)),
        ]
        await asyncio.to_thread(found.indexer.delete_chats, chats, meta_keys=keys)
    except Exception:  # noqa: BLE001 - a copy must never fail the turn
        _logger.warning("recall: could not remove the turns of %s", main_id, exc_info=True)
