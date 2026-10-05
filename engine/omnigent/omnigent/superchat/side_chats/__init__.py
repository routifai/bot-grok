"""Side Chats: open, discover and auto-archive short-lived branches of the Super Chat.

Layout: ``chats`` (eligibility, request bodies, archive sweep), ``routes``
(``POST /sessions/{id}/side_chats``), ``tools`` (``side_chat_open`` def), ``handlers`` (runner
side), this module (registration). Imports stay lazy so importing a submodule never loads the
server.
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
    """Hand the sweeper job the conversation store (its route mounts on the sessions router)."""
    app.state.side_chat_conversation_store = deps.conversation_store


def _jobs(app: FastAPI) -> list[BackgroundJob]:
    """The idle Side Chat archive sweeper (never touches the Super Chat)."""
    from omnigent.superchat.side_chats.chats import SideChatArchiveSweeper

    conversation_store = getattr(app.state, "side_chat_conversation_store", None)
    if conversation_store is None:
        return []
    sweeper = SideChatArchiveSweeper(conversation_store)
    app.state.side_chat_archive_sweeper = sweeper
    return [sweeper]


FEATURE = Feature(
    name="side_chats",
    tools=_tools,
    handlers={SIDE_CHAT_TOOL_NAME: handle_side_chat_tool},
    install=_install,
    jobs=_jobs,
)
