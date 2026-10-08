"""Side Chats: open, discover and auto-archive short-lived branches of the Super Chat.

Layout: ``chats`` (eligibility, request bodies, unarchive rule), ``archiving`` (the setting
and the one sweeper), ``routes`` (``POST /sessions/{id}/side_chats``), ``tools``
(``side_chat_open`` def), ``handlers`` (runner side), this module (registration). Imports stay
lazy so importing a submodule never loads the server.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING

from omnigent.superchat.feature import BackgroundJob, Feature, InstallDeps, ToolManagerCtx
from omnigent.superchat.side_chats.handlers import handle_side_chat_tool

if TYPE_CHECKING:
    from fastapi import FastAPI

    from omnigent.tools.base import Tool

SIDE_CHAT_TOOL_NAME = "side_chat_open"


def _tools(labels: Mapping[str, str] | None, _ctx: ToolManagerCtx) -> list[Tool]:
    """Offered to the Super Chat, its Side Chats and Helpers; dispatch refuses non-Super-Chat."""
    from omnigent.context.labels import is_superside_chat
    from omnigent.superchat.side_chats.tools import SideChatOpenTool

    return [SideChatOpenTool()] if is_superside_chat(labels) else []


def _install(app: FastAPI, deps: InstallDeps) -> None:
    """Wire the sweeper's stores and mount ``/v1/me/archiving`` (needs the task store's DB)."""
    app.state.side_chat_conversation_store = deps.conversation_store
    app.state.side_chat_runner_router = deps.runner_router
    if deps.scheduled_task_store is None:
        return
    from omnigent.superchat.side_chats.archiving import (
        ArchivePrefsStore,
        register_archiving_routes,
    )

    prefs = ArchivePrefsStore(deps.scheduled_task_store.storage_location)
    app.state.side_chat_archive_prefs = prefs
    app.include_router(
        register_archiving_routes(prefs, auth_provider=deps.auth_provider),
        prefix="/v1",
        tags=["side_chats"],
    )


def _jobs(app: FastAPI) -> list[BackgroundJob]:
    """The one Side Chat archive sweeper (never touches the Super Chat or Helpers)."""
    from omnigent.superchat.side_chats.archiving import (
        SideChatArchiveSweeper,
        manual_archive_steps,
    )

    conversation_store = getattr(app.state, "side_chat_conversation_store", None)
    if conversation_store is None:
        return []
    sweeper = SideChatArchiveSweeper(
        getattr(app.state, "side_chat_archive_prefs", None),
        conversation_store,
        manual_archive_steps(app, conversation_store),
    )
    app.state.side_chat_archive_sweeper = sweeper
    return [sweeper]


FEATURE = Feature(
    name="side_chats",
    tools=_tools,
    handlers={SIDE_CHAT_TOOL_NAME: handle_side_chat_tool},
    install=_install,
    jobs=_jobs,
)
