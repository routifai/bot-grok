"""``GET /sessions/{id}/transcript``: a session's items as typed chat blocks.

After a reset (``POST .../reset``) the transcript starts at the reset: paging back stops there
(``has_more`` false) and ``reset`` names the checkpoint. ``before_reset=true`` reads the
history before the latest reset instead, paged the same way. Every string is redacted of the
secrets the engine knows (:mod:`omnigent.server.redaction`).
"""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, Query, Request

from omnigent.context.rollover import _MID_TURN_LIVE_STATUSES
from omnigent.entities import Conversation
from omnigent.server.auth import LEVEL_READ, AuthProvider
from omnigent.server.redaction import session_redactor
from omnigent.server.routes._auth_helpers import get_user_id as _get_user_id
from omnigent.server.routes._auth_helpers import (
    require_access_and_level as _require_access_and_level,
)
from omnigent.server.routes._errors import session_not_found as _session_not_found
from omnigent.stores import ConversationStore
from omnigent.stores.permission_store import PermissionStore
from omnigent.superchat.family.tree import sub_agent_status
from omnigent.superchat.lineage import session_lineage
from omnigent.superchat.side_chats.forks import attach_forks, forks_by_anchor
from omnigent.superchat.transcript.blocks import helper_session_ids, project_items
from omnigent.superchat.transcript.reset import latest_reset_item

#: Items a page asks for when one call is not enough to find a tool call's output.
_LOOKAHEAD_ITEMS = 100


def read_transcript(
    conv_store: ConversationStore,
    conversation: Conversation,
    *,
    before: str | None,
    limit: int,
    include_seed: bool,
    before_reset: bool = False,
    viewer_id: str | None = None,
) -> dict[str, Any]:
    """One page of a session's transcript, oldest message first.

    Pages walk back from the newest items (``before`` is the ``older_cursor`` of the page
    after). A Side Chat's seeded context is cut unless ``include_seed``. Paging stops at the
    latest reset; ``before_reset`` pages the items older than it instead. Each message
    carries the ``forks`` anchored on it (``unread`` is *viewer_id*'s), so forks anchored
    before a reset show only on the ``before_reset`` pages.
    """
    lineage = session_lineage(conv_store, conversation)
    reset = latest_reset_item(conv_store, conversation.id)
    reset_info = {"item_id": reset.id, "created_at": reset.created_at} if reset else None
    live = conversation.live_status in _MID_TURN_LIVE_STATUSES
    if before_reset and reset is None:
        return _page([], has_more=False, older_cursor=None, lineage=lineage, reset=None, live=live)
    if before_reset and before is None:
        before = reset.id if reset else None
    # Newest first, so "further along" the store's sort is older: the older page is `after`.
    page = conv_store.list_items(conversation.id, limit=limit, after=before, order="desc")
    newest_first = [item.to_api_dict() for item in page.data]
    seed_id = lineage["seed_item_id"]
    has_more = page.has_more
    cuts = [seed_id] if seed_id and not include_seed else []
    if reset is not None and not before_reset:
        cuts.append(reset.id)
    index = next((i for i, item in enumerate(newest_first) if item["id"] in cuts), -1)
    if index != -1:
        newest_first, has_more = newest_first[:index], False
    items = list(reversed(newest_first))
    # A call whose output is newer than this page ends it: read ahead for the output.
    if newest_first and before is not None:
        calls = {i["call_id"] for i in items if i["type"] == "function_call" and i.get("call_id")}
        done = {i["call_id"] for i in items if i["type"] == "function_call_output"}
        if calls - done:
            ahead = conv_store.list_items(
                conversation.id, limit=_LOOKAHEAD_ITEMS, after=newest_first[0]["id"], order="asc"
            )
            items += [
                i.to_api_dict()
                for i in ahead.data
                if i.type == "function_call_output" and i.data.call_id in calls - done
            ]
    helper_ids = helper_session_ids(items)
    statuses: dict[str, str] = {}
    if helper_ids:
        for helper_id, helper in conv_store.get_conversations(helper_ids).items():
            statuses[helper_id] = sub_agent_status(helper)
    messages = project_items(items, helper_statuses=statuses)
    can_fork = lineage["kind"] == "super" or lineage["anchor_item_id"] is not None
    grouped = forks_by_anchor(conv_store, conversation, viewer_id) if can_fork and messages else {}
    return _page(
        attach_forks(messages, grouped),
        has_more=has_more,
        older_cursor=newest_first[-1]["id"] if newest_first and has_more else None,
        lineage=lineage,
        reset=reset_info,
        live=live,
    )


def _page(
    data: list[dict[str, Any]],
    *,
    has_more: bool,
    older_cursor: str | None,
    lineage: dict[str, Any],
    reset: dict[str, Any] | None,
    live: bool,
) -> dict[str, Any]:
    return {
        "data": data,
        "has_more": has_more,
        "older_cursor": older_cursor,
        "lineage": lineage,
        "reset": reset,
        "live": live,
    }


def register_transcript_routes(
    router: APIRouter,
    *,
    conversation_store: ConversationStore,
    auth_provider: AuthProvider | None = None,
    permission_store: PermissionStore | None = None,
) -> None:
    """Register ``GET /sessions/{session_id}/transcript``."""

    @router.get("/sessions/{session_id}/transcript", response_model=None)
    async def get_session_transcript(
        request: Request,
        session_id: str,
        limit: int = Query(default=50, ge=1, le=200),
        before: str | None = Query(default=None),
        include_seed: bool = Query(default=False),
        before_reset: bool = Query(default=False),
    ) -> dict[str, Any]:
        """
        A session's transcript as typed blocks (``text``, ``card``, ``helper``, ``file``,
        ``secure_entry``, ``error``).

        :param session_id: Any session the caller can READ (same gate as ``.../items``).
        :param limit: Items per page, newest page first.
        :param before: Cursor: the ``older_cursor`` of the page after this one.
        :param include_seed: Also return a with-context Side Chat's copied context.
        :param before_reset: Page the history before the latest reset instead (empty when the
            session was never reset).
        :returns: ``{"data": [message], "has_more", "older_cursor", "lineage", "reset", "live"}``:
            ``reset`` is ``{"item_id", "created_at"}`` of the latest reset or ``None``; ``live``
            is whether a turn is in flight. Each message has ``forks`` (``[]`` when none:
            ``{session_id, title, replies, live, unread, state, summary, created_at}``) and an
            added fork's ``fork_summary`` block.
        :raises OmnigentError: 403 without READ; 404 if no session exists.
        """
        user_id = _get_user_id(request, auth_provider)
        access = await _require_access_and_level(
            user_id, session_id, LEVEL_READ, permission_store, conversation_store
        )
        conversation = access.conversation or await asyncio.to_thread(
            conversation_store.get_conversation, session_id
        )
        if conversation is None:
            raise _session_not_found()
        page = await asyncio.to_thread(
            read_transcript,
            conversation_store,
            conversation,
            before=before,
            limit=limit,
            include_seed=include_seed,
            before_reset=before_reset,
            viewer_id=user_id,
        )
        redactor = await session_redactor(request, conversation_store, session_id, user_id)
        return redactor.deep(page)
