"""``/v1/me/topics`` and ``/v1/me/feed``: what the person follows and what it found.

* ``GET /me/topics`` -> ``{"data": [topic]}``, oldest first: the caller's followed topics.
* ``GET /me/feed?before&limit&topic_id&include_nothing_new`` -> ``{"data": [post],
  "has_more", "next_cursor"}``, newest first: the finished runs of those topics. Runs that found
  nothing (``nothing_new``) are left out unless ``include_nothing_new=true``.

Both are redacted of the secrets the engine knows (:mod:`omnigent.server.redaction`).
``before`` is the opaque ``next_cursor`` of the page before. Each topic contributes at most its
:data:`RUNS_PER_TOPIC` newest runs, so the feed is a recent window, not an archive.
"""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, Query, Request

from omnigent.db.account_authority import account_generation, current_account_user
from omnigent.entities import ScheduledTask
from omnigent.errors import ErrorCode, OmnigentError
from omnigent.server.auth import RESERVED_USER_LOCAL, AuthProvider
from omnigent.server.redaction import request_redactor
from omnigent.server.routes._auth_helpers import require_user
from omnigent.stores import ConversationStore
from omnigent.stores.scheduled_task_store import ScheduledTaskStore
from omnigent.superchat.feed.topics import is_followed_topic, post_from_items, topic_to_response

RUNS_PER_TOPIC = 50
_ITEMS_PER_RUN = 200

_Entry = tuple[int, str, ScheduledTask, str]


def _decode_cursor(raw: str) -> tuple[int, str]:
    stamp, _, run_id = raw.partition(":")
    try:
        return int(stamp), run_id
    except ValueError:
        raise OmnigentError("Invalid cursor", code=ErrorCode.INVALID_INPUT) from None


def create_feed_router(
    *,
    scheduled_task_store: ScheduledTaskStore,
    conversation_store: ConversationStore,
    auth_provider: AuthProvider | None,
) -> APIRouter:
    """Build the feed router, mounted with ``prefix="/v1"``."""
    router = APIRouter()

    def _topics(request: Request) -> list[ScheduledTask]:
        user_id = require_user(request, auth_provider)
        owner_id = None if user_id in (None, RESERVED_USER_LOCAL) else user_id
        return [
            task
            for task in scheduled_task_store.list(owner_user_id=owner_id)
            if task.user_id == owner_id
            and (
                current_account_user() is None
                or task.account_generation == account_generation(owner_id or RESERVED_USER_LOCAL)
            )
            and is_followed_topic(task)
        ]

    @router.get("/me/topics")
    async def list_topics(request: Request) -> dict[str, Any]:
        """The topics the Muse follows for the caller."""
        tasks = await asyncio.to_thread(_topics, request)
        redactor = request_redactor(request, require_user(request, auth_provider))
        return redactor.deep({"data": [topic_to_response(task) for task in tasks]})

    @router.get("/me/feed")
    async def list_feed(
        request: Request,
        before: str | None = Query(default=None),
        limit: int = Query(default=20, ge=1, le=100),
        topic_id: str | None = Query(default=None),
        include_nothing_new: bool = Query(default=False),
    ) -> dict[str, Any]:
        """Posts from the caller's followed topics, newest first."""
        tasks = await asyncio.to_thread(_topics, request)
        if topic_id is not None:
            tasks = [task for task in tasks if task.id == topic_id]
        cursor = _decode_cursor(before) if before else None

        def runs() -> list[_Entry]:
            found: list[_Entry] = []
            for task in tasks:
                page, _ = scheduled_task_store.list_runs(task.id, limit=RUNS_PER_TOPIC)
                for run in page:
                    if run.status != "succeeded" or not run.conversation_id:
                        continue
                    when = run.finished_at or run.fired_at or run.scheduled_at
                    found.append((when, run.id, task, run.conversation_id))
            found.sort(key=lambda r: (r[0], r[1]), reverse=True)
            if cursor is not None:
                found = [r for r in found if (r[0], r[1]) < cursor]
            return found

        def post_of(entry: _Entry) -> dict[str, Any] | None:
            when, run_id, task, session_id = entry
            page = conversation_store.list_items(session_id, limit=_ITEMS_PER_RUN, order="asc")
            return post_from_items(
                [item.to_api_dict() for item in page.data],
                run_id=run_id,
                topic_id=task.id,
                session_id=session_id,
                created_at=when,
            )

        posts: list[dict[str, Any]] = []
        has_more = False
        for entry in await asyncio.to_thread(runs):
            post = await asyncio.to_thread(post_of, entry)
            if post is None or (post["nothing_new"] and not include_nothing_new):
                continue
            if len(posts) == limit:
                has_more = True
                break
            posts.append(post)
        next_cursor = f"{posts[-1]['created_at']}:{posts[-1]['run_id']}" if has_more else None
        redactor = request_redactor(request, require_user(request, auth_provider))
        return redactor.deep({"data": posts, "has_more": has_more, "next_cursor": next_cursor})

    return router
