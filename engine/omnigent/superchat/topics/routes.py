"""Topics (ADR 0035): the owner's topics, picking one up, and the writer endpoint.

* ``GET /v1/me/topics?days=7`` lists the owner's open topics touched within ``days`` (at most
  7), newest first; closed ones are hidden.
* ``POST /v1/me/topics/{key}/pick`` appends one ``topic`` card to the owner's Conversation:
  no turn starts and nothing is sent to the model now; the card is part of the record.
* ``POST /v1/topics/write`` is what the Helper's ``topics_update`` tool calls: it validates,
  trims and upserts by key.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import UTC, datetime
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel, ConfigDict, Field

from omnigent.db.db_models import InvalidUuidError, uuid_to_bytes
from omnigent.errors import ErrorCode, OmnigentError
from omnigent.server.auth import LEVEL_OWNER, RESERVED_USER_LOCAL, AuthProvider
from omnigent.server.routes._auth_helpers import require_access, require_user
from omnigent.stores import ConversationStore, PermissionStore
from omnigent.superchat.feature import RECORDED_RESPONSE_PREFIX
from omnigent.superchat.topics.store import SqlAlchemyTopicStore
from omnigent.superchat.topics.topic import WINDOW_DAYS, Topic, clean_key

#: The kind of the card a pick appends; drawn by the client, never a ``render_card`` kind the
#: model is offered.
TOPIC_CARD = "topic"
#: The call a pick's card is recorded as, so the transcript draws it like any reply card.
_CARD_CALL = "render_card"


def _zone(timezone: str | None) -> ZoneInfo:
    """The owner's IANA zone, UTC when empty or unknown."""
    try:
        return ZoneInfo(timezone) if timezone else ZoneInfo("UTC")
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo("UTC")


class WriteTopicsBody(BaseModel):
    """Body of ``POST /v1/topics/write``."""

    model_config = ConfigDict(extra="forbid")

    parent_session_id: str
    topics: list[Any] = Field(default_factory=list)


class PickBody(BaseModel):
    """Body of ``POST /v1/me/topics/{key}/pick``."""

    model_config = ConfigDict(extra="forbid")

    conversation_id: str


def topic_to_response(topic: Topic) -> dict[str, Any]:
    """Serialize a topic for the REST API (``watch`` is the watch's own, not shown)."""
    return {
        "key": topic.key,
        "title": topic.title,
        "left_off": topic.left_off,
        "covered": topic.covered,
        "open": topic.open,
        "starters": topic.starters,
        "events": topic.events,
        "sources": topic.sources,
        "status": topic.status,
        "since": topic.since or None,
        "since_at": topic.since_at,
        "last_touched_at": topic.last_touched_at,
        "updated_at": topic.updated_at,
    }


def _fallback(topic: Topic) -> str:
    """The card as markdown: what the model reads in the record, and any client without it."""
    lines = [f"Picked up **{topic.title}**."]
    if topic.left_off:
        lines.append(f"Where we left off: {topic.left_off}")
    if topic.since:
        lines.append(f"New since then: {topic.since}")
    if topic.covered:
        lines.append("What we covered:")
        lines += [f"- {c['date']} {c['kind']}: {c['text']}" for c in topic.covered]
    if topic.open:
        lines.append("Still open:")
        lines += [f"- {o['kind']}: {o['text']}" for o in topic.open]
    return "\n".join(lines)


def topic_card(topic: Topic) -> dict[str, Any]:
    """The ``topic`` card a pick appends, in the shape ``render_card`` returns."""
    return {
        "type": "card",
        "card": TOPIC_CARD,
        "id": f"topic-{topic.key}-{uuid.uuid4().hex[:8]}",
        "title": topic.title,
        "data": {
            "key": topic.key,
            "title": topic.title,
            "left_off": topic.left_off,
            "covered": topic.covered,
            "open": topic.open,
            "starters": topic.starters,
            "sources": topic.sources,
            "since": topic.since or None,
            "since_at": topic.since_at,
            "last_touched_at": topic.last_touched_at,
        },
        "fallback": _fallback(topic),
    }


def append_topic_card(
    conversation_store: ConversationStore, conversation_id: str, card: dict[str, Any]
) -> None:
    """Blocking: record *card* in the Conversation as a finished card call and publish it.

    Stored as a ``render_card`` call with its result, so the transcript draws it like any reply
    card and a session assembled from the record reads the card's fallback. No turn starts, and
    its ``response_id`` (:data:`RECORDED_RESPONSE_PREFIX`) keeps it out of the Activity feed.
    """
    from omnigent.entities import (
        FunctionCallData,
        FunctionCallOutputData,
        NewConversationItem,
    )
    from omnigent.server.routes._sessions.helpers import _publish_external_conversation_item

    response_id = f"{RECORDED_RESPONSE_PREFIX}topic_{uuid.uuid4().hex}"
    call_id = f"call_topic_{uuid.uuid4().hex[:24]}"
    arguments = {k: card[k] for k in ("card", "id", "title", "data", "fallback")}
    persisted = conversation_store.append(
        conversation_id,
        [
            NewConversationItem(
                type="function_call",
                response_id=response_id,
                data=FunctionCallData(
                    agent="superchat",
                    name=_CARD_CALL,
                    arguments=json.dumps(arguments, ensure_ascii=False),
                    call_id=call_id,
                ),
            ),
            NewConversationItem(
                type="function_call_output",
                response_id=response_id,
                data=FunctionCallOutputData(
                    call_id=call_id, output=json.dumps(card, ensure_ascii=False)
                ),
            ),
        ],
    )
    for item in persisted:
        _publish_external_conversation_item(conversation_id, item)


def create_topics_router(
    store: SqlAlchemyTopicStore,
    *,
    scheduled_task_store: Any,
    conversation_store: ConversationStore,
    permission_store: PermissionStore | None = None,
    auth_provider: AuthProvider | None = None,
) -> APIRouter:
    """Build the topics router, mounted with ``prefix="/v1"``."""
    router = APIRouter()

    def _owner(request: Request) -> str:
        user_id = require_user(request, auth_provider)
        return user_id if user_id is not None else RESERVED_USER_LOCAL

    async def _require_chat(owner: str, session_id: str) -> None:
        try:
            uuid_to_bytes(session_id)
        except InvalidUuidError as exc:
            raise OmnigentError("invalid session id", code=ErrorCode.INVALID_INPUT) from exc
        await require_access(owner, session_id, LEVEL_OWNER, permission_store, conversation_store)

    @router.get("/me/topics")
    async def list_topics(
        request: Request, days: int = Query(default=WINDOW_DAYS, ge=1, le=WINDOW_DAYS)
    ) -> dict[str, Any]:
        """The owner's open topics touched within ``days``, newest first."""
        owner = _owner(request)
        topics = await asyncio.to_thread(store.list_recent, owner, days=days)
        return {"topics": [topic_to_response(t) for t in topics]}

    @router.post("/me/topics/{key}/pick")
    async def pick_topic(request: Request, key: str, body: PickBody) -> dict[str, Any]:
        """Append the topic's card to the Conversation (no turn starts) and return it."""
        owner = _owner(request)
        await _require_chat(owner, body.conversation_id)
        conv = await asyncio.to_thread(conversation_store.get_conversation, body.conversation_id)
        if conv is None or conv.parent_conversation_id is not None:
            raise OmnigentError("not a Conversation", code=ErrorCode.INVALID_INPUT)
        topic = await asyncio.to_thread(store.get, owner, clean_key(key))
        if topic is None or topic.status != "open":
            raise OmnigentError("no such topic", code=ErrorCode.NOT_FOUND)
        card = topic_card(topic)
        await asyncio.to_thread(append_topic_card, conversation_store, body.conversation_id, card)
        return {"card": card}

    @router.post("/topics/write")
    async def write_topics(request: Request, body: WriteTopicsBody) -> dict[str, Any]:
        """The quiet-moment Helper's upsert: cleaned, trimmed, by key."""
        owner = _owner(request)
        await _require_chat(owner, body.parent_session_id)
        prefs = await asyncio.to_thread(scheduled_task_store.get_owner_preferences, owner)
        zone = _zone(prefs.timezone if prefs else None)
        result = await asyncio.to_thread(store.update, owner, body.topics, zone=zone)
        written = result["written"]
        return {
            **result,
            "new": sum(1 for w in written if w["created"]),
            "reused": sum(1 for w in written if not w["created"]),
            "at": datetime.now(UTC).isoformat(timespec="seconds"),
        }

    return router
