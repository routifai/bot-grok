"""REST routes for the feed primitive (``/feed``, mounted under ``/v1/nova``).

Ported from the TypeScript prototype's ``apps/api/src/muse-feed.ts``
(``feed.list``, ``topics.list``/``follow``/``remove``) and ``ideas.ts``
(``ideas.list``). Every route is scoped to the caller (Rule 3 — private
stays private): there is no cross-person access, and no ACL to check.
"""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel

from omnigent.errors import ErrorCode, OmnigentError
from omnigent.nova._shared import NovaActor, NovaDeps, actor_from_request
from omnigent.nova.feed import create_store
from omnigent.nova.feed.entities import FeedPost, FollowedTopic, Idea
from omnigent.nova.feed.service import FeedService


class FollowTopicRequest(BaseModel):
    topic: str


def _require_actor(request: Request, deps: NovaDeps) -> NovaActor:
    """Resolve the caller or raise 401.

    :raises OmnigentError: ``UNAUTHORIZED`` if the request has no identity.
    """
    actor = actor_from_request(request, deps.auth_provider)
    if actor is None:
        raise OmnigentError("Authentication required", code=ErrorCode.UNAUTHORIZED)
    return actor


def _post_response(post: FeedPost) -> dict[str, Any]:
    return {
        "id": post.id,
        "object": "feed.post",
        "kind": post.kind,
        "title": post.title,
        "body": post.body,
        "goal_id": post.goal_id,
        "source_url": post.source_url,
        "created_at": post.created_at,
    }


def _topic_response(topic: FollowedTopic) -> dict[str, Any]:
    return {
        "id": topic.id,
        "object": "feed.topic",
        "topic": topic.topic,
        "created_at": topic.created_at,
    }


def _idea_response(idea: Idea) -> dict[str, Any]:
    return {
        "id": idea.id,
        "object": "feed.idea",
        "text": idea.text,
        "area": idea.area,
        "detail": idea.detail,
        "illustration": idea.illustration,
        "created_at": idea.created_at,
    }


def create_router(deps: NovaDeps) -> APIRouter:
    """Build the feed router.

    :param deps: Server-owned dependencies (storage location, auth provider).
    :returns: A configured :class:`APIRouter`, mounted at ``/v1/nova`` by
        ``omnigent.nova.include_routers``.
    """
    service = FeedService(create_store(deps.storage_location))
    router = APIRouter()

    @router.get("/feed")
    async def list_feed(request: Request, cursor: str | None = None) -> dict[str, Any]:
        """List the caller's feed posts, newest first.

        :raises OmnigentError: 401 unauthenticated, 400 on a malformed cursor.
        """
        actor = _require_actor(request, deps)
        page = await asyncio.to_thread(service.list_posts, actor, cursor=cursor)
        return {
            "object": "list",
            "data": [_post_response(p) for p in page.posts],
            "next_cursor": page.next_cursor,
        }

    @router.get("/feed/topics")
    async def list_topics(request: Request) -> dict[str, Any]:
        """List the caller's followed topics, oldest-followed first."""
        actor = _require_actor(request, deps)
        topics = await asyncio.to_thread(service.list_topics, actor)
        return {"object": "list", "data": [_topic_response(t) for t in topics]}

    @router.post("/feed/topics")
    async def follow_topic(request: Request, body: FollowTopicRequest) -> dict[str, Any]:
        """Follow a topic, idempotently, up to the per-person cap.

        :raises OmnigentError: 401 unauthenticated, 400 if ``topic`` is empty
            or the caller already follows the maximum number of topics.
        """
        actor = _require_actor(request, deps)
        topic = await asyncio.to_thread(service.follow_topic, actor, body.topic)
        return _topic_response(topic)

    @router.delete("/feed/topics/{topic_id}")
    async def unfollow_topic(request: Request, topic_id: str) -> dict[str, Any]:
        """Unfollow a topic.

        :raises OmnigentError: 401 unauthenticated, 404 if not found / not owned.
        """
        actor = _require_actor(request, deps)
        removed = await asyncio.to_thread(service.unfollow_topic, actor, topic_id)
        if not removed:
            raise OmnigentError("Topic not found", code=ErrorCode.NOT_FOUND)
        return {"id": topic_id, "object": "feed.topic.deleted", "deleted": True}

    @router.get("/feed/ideas")
    async def list_ideas(request: Request) -> dict[str, Any]:
        """List the caller's current ideas, in suggested order."""
        actor = _require_actor(request, deps)
        ideas = await asyncio.to_thread(service.list_ideas, actor)
        return {"object": "list", "data": [_idea_response(i) for i in ideas]}

    return router
