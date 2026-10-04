"""Suggestions (Ideas): background runs record them, a UI accepts or dismisses them.

Layout: ``store``, ``routes`` (``/v1/suggestions``), ``tools`` (tool defs), ``handlers``
(runner side). Imports stay lazy so importing a submodule never loads the server.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING

from omnigent.context.labels import is_superside_chat
from omnigent.superchat.feature import Feature, InstallDeps, ToolManagerCtx
from omnigent.superchat.suggestions.handlers import handle_suggestion_tool
from omnigent.superchat.suggestions.tools import SUGGESTION_TOOL_NAMES

if TYPE_CHECKING:
    from fastapi import FastAPI

    from omnigent.tools.base import Tool


def _tools(labels: Mapping[str, str] | None, _ctx: ToolManagerCtx) -> list[Tool]:
    """Offered to the Super Chat and to Helpers alike (a Helper records under its parent)."""
    from omnigent.superchat.suggestions.tools import SuggestionCreateTool, SuggestionListTool

    if not is_superside_chat(labels):
        return []
    return [SuggestionCreateTool(), SuggestionListTool()]


def _install(app: FastAPI, deps: InstallDeps) -> None:
    from omnigent.superchat.suggestions.routes import create_suggestions_router
    from omnigent.superchat.suggestions.store import SqlAlchemySuggestionStore

    if deps.scheduled_task_store is None:
        return
    app.include_router(
        create_suggestions_router(
            SqlAlchemySuggestionStore(deps.scheduled_task_store.storage_location),
            conversation_store=deps.conversation_store,
            permission_store=deps.permission_store,
            auth_provider=deps.auth_provider,
        ),
        prefix="/v1",
        tags=["suggestions"],
    )


FEATURE = Feature(
    name="suggestions",
    tools=_tools,
    handlers=dict.fromkeys(SUGGESTION_TOOL_NAMES, handle_suggestion_tool),
    install=_install,
)
