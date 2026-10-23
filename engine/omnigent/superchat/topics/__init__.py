"""Topics (ADR 0035): what the person is working on, kept by the quiet-moment pass.

Layout: ``topic`` (the record and its cleaning rules, pure), ``store``, ``routes`` (list, pick,
write), ``tools`` (tool def), ``handlers`` (runner side), ``note`` (the next turn's one line
after a pick). The quiet brief reads the owner's
topics through :func:`omnigent.superchat.feature.topics_brief`; other capabilities use
:func:`list_watched_topics` and :func:`mark_topic_new`. Imports stay lazy so importing a
submodule never loads the server.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING

from omnigent.superchat.feature import (
    Feature,
    InstallDeps,
    ToolManagerCtx,
    is_helper,
    register_topics_brief,
)
from omnigent.superchat.topics.handlers import handle_topics_tool
from omnigent.superchat.topics.note import deliver_topic_pick
from omnigent.superchat.topics.store import brief_lines, list_watched_topics, mark_topic_new
from omnigent.superchat.topics.tools import TOPIC_TOOL_NAMES

if TYPE_CHECKING:
    from fastapi import FastAPI

    from omnigent.tools.base import Tool

__all__ = ["FEATURE", "list_watched_topics", "mark_topic_new"]


def _tools(labels: Mapping[str, str] | None, _ctx: ToolManagerCtx) -> list[Tool]:
    """Only a Super Chat's Helpers write topics (the ``notes`` Type lists it)."""
    from omnigent.superchat.topics.tools import TopicsUpdateTool

    return [TopicsUpdateTool()] if is_helper(labels) else []


def _install(app: FastAPI, deps: InstallDeps) -> None:
    from omnigent.superchat.topics import store as store_module
    from omnigent.superchat.topics.routes import create_topics_router

    if deps.scheduled_task_store is None:
        return
    topic_store = store_module.SqlAlchemyTopicStore(deps.scheduled_task_store.storage_location)
    store_module.install(topic_store)
    app.state.topic_store = topic_store
    register_topics_brief(brief_lines)
    app.include_router(
        create_topics_router(
            topic_store,
            scheduled_task_store=deps.scheduled_task_store,
            conversation_store=deps.conversation_store,
            permission_store=deps.permission_store,
            auth_provider=deps.auth_provider,
        ),
        prefix="/v1",
        tags=["topics"],
    )


FEATURE = Feature(
    name="topics",
    tools=_tools,
    handlers=dict.fromkeys(TOPIC_TOOL_NAMES, handle_topics_tool),
    turn_prefix=deliver_topic_pick,
    install=_install,
)
