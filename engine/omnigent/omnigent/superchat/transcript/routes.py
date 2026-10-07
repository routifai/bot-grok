"""``GET /sessions/{id}/transcript``: a session's items as typed chat blocks."""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, Query, Request

from omnigent.context.rollover import side_chat_seed_checkpoint
from omnigent.entities import Conversation
from omnigent.server.auth import LEVEL_READ, AuthProvider
from omnigent.server.routes._auth_helpers import get_user_id as _get_user_id
from omnigent.server.routes._auth_helpers import (
    require_access_and_level as _require_access_and_level,
)
from omnigent.server.routes._errors import session_not_found as _session_not_found
from omnigent.stores import ConversationStore
from omnigent.stores.conversation_store import side_chat_parent_id
from omnigent.stores.permission_store import PermissionStore
from omnigent.superchat.activity.derive import resolve_super_chat_id, sub_agent_status
from omnigent.superchat.feature import is_helper, is_super_chat
from omnigent.superchat.transcript.blocks import helper_session_ids, project_items

_MAX_HELPER_HOPS = 8
#: Items a page asks for when one call is not enough to find a tool call's output.
_LOOKAHEAD_ITEMS = 100


def session_lineage(conv_store: ConversationStore, conversation: Conversation) -> dict[str, Any]:
    """Where a session sits: ``kind`` (``super`` / ``side`` / ``helper`` / ``None``), its root.

    :returns: ``{"kind", "root_id", "parent_id", "seed_item_id"}``; ``seed_item_id`` is the
        checkpoint a with-context Side Chat starts after.
    """
    labels = conversation.labels
    lineage: dict[str, Any] = {
        "kind": None,
        "root_id": None,
        "parent_id": None,
        "seed_item_id": None,
    }
    if conversation.kind == "sub_agent" or is_helper(labels):
        root = conversation
        for _ in range(_MAX_HELPER_HOPS):
            if root.kind != "sub_agent" or not root.parent_conversation_id:
                break
            root = conv_store.get_conversation(root.parent_conversation_id) or root
            if root.kind != "sub_agent":
                break
        lineage.update(
            kind="helper",
            root_id=resolve_super_chat_id(conv_store, root.id),
            parent_id=conversation.parent_conversation_id,
        )
    elif (parent := side_chat_parent_id(labels)) is not None:
        _, seed_item_id = side_chat_seed_checkpoint(conv_store, conversation)
        lineage.update(kind="side", root_id=parent, parent_id=parent, seed_item_id=seed_item_id)
    elif is_super_chat(labels):
        lineage.update(kind="super", root_id=conversation.id)
    return lineage


def read_transcript(
    conv_store: ConversationStore,
    conversation: Conversation,
    *,
    before: str | None,
    limit: int,
    include_seed: bool,
) -> dict[str, Any]:
    """One page of a session's transcript, oldest message first.

    Pages walk back from the newest items (``before`` is the ``older_cursor`` of the page
    after). A Side Chat's seeded context is cut unless ``include_seed``.
    """
    lineage = session_lineage(conv_store, conversation)
    # Newest first, so "further along" the store's sort is older: the older page is `after`.
    page = conv_store.list_items(conversation.id, limit=limit, after=before, order="desc")
    newest_first = [item.to_api_dict() for item in page.data]
    seed_id = lineage["seed_item_id"]
    has_more = page.has_more
    if seed_id and not include_seed:
        index = next((i for i, item in enumerate(newest_first) if item["id"] == seed_id), -1)
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
    return {
        "data": project_items(items, helper_statuses=statuses),
        "has_more": has_more,
        "older_cursor": newest_first[-1]["id"] if newest_first and has_more else None,
        "lineage": lineage,
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
    ) -> dict[str, Any]:
        """
        A session's transcript as typed blocks (``text``, ``card``, ``helper``, ``file``,
        ``secure_entry``, ``error``).

        :param session_id: Any session the caller can READ (same gate as ``.../items``).
        :param limit: Items per page, newest page first.
        :param before: Cursor: the ``older_cursor`` of the page after this one.
        :param include_seed: Also return a with-context Side Chat's copied context.
        :returns: ``{"data": [message], "has_more", "older_cursor", "lineage"}``.
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
        return await asyncio.to_thread(
            read_transcript,
            conversation_store,
            conversation,
            before=before,
            limit=limit,
            include_seed=include_seed,
        )
