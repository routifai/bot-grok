"""Knowledge: a person's own file search (a small RAG over the files in their Computer).

The Computer's workspace is the one copy of a person's files, and the index lives there too
(``omnigent.runner.knowledge``: parse, passages, thumbnails, FTS5 + sqlite-vec). This folder is the
engine's side and holds no file data: ``tools`` / ``handlers`` register the Muse's
``files_search`` / ``files_read_page`` (the handler runs in the Computer), and ``routes`` relays
status, search and page thumbnails to it for Nova. Embeddings are made through the engine's model
proxy (``models``), so no key enters the Computer.

It sits on ``artifacts`` only to tell a Library file from a plain one in the answers (matched by
the workspace path the artifact was saved from).
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import TYPE_CHECKING

from omnigent.context.labels import is_superside_chat
from omnigent.superchat.feature import Feature, InstallDeps, ToolManagerCtx
from omnigent.superchat.knowledge.handlers import handle_knowledge_tool
from omnigent.superchat.knowledge.tools import KNOWLEDGE_TOOL_NAMES

if TYPE_CHECKING:
    from fastapi import FastAPI

    from omnigent.superchat.feature import HandlerCtx
    from omnigent.tools.base import Tool

#: Handlers the engine's relays call; never offered to a model.
_INTERNAL_OPS = ("files_status", "files_thumbnail", "files_reindex")


def _tools(labels: Mapping[str, str] | None, _ctx: ToolManagerCtx) -> list[Tool]:
    """The Super Chat and its Helpers search the person's files."""
    from omnigent.superchat.knowledge.tools import FilesReadPageTool, FilesSearchTool

    if not is_superside_chat(labels):
        return []
    return [FilesSearchTool(), FilesReadPageTool()]


def _install(app: FastAPI, deps: InstallDeps) -> None:
    from omnigent.runtime import get_artifact_store
    from omnigent.superchat.artifacts import SqlAlchemyArtifactStore
    from omnigent.superchat.knowledge.routes import create_knowledge_router

    if deps.scheduled_task_store is None or deps.conversation_store is None:
        return
    location = deps.scheduled_task_store.storage_location
    app.include_router(
        create_knowledge_router(
            conversation_store=deps.conversation_store,
            artifact_store=SqlAlchemyArtifactStore(location, get_artifact_store),
            runner_router=deps.runner_router,
            permission_store=deps.permission_store,
            auth_provider=deps.auth_provider,
        ),
        prefix="/v1",
        tags=["knowledge"],
    )


def _on_result(ctx: HandlerCtx, output: str) -> None:
    """A file the Muse saved as an artifact is searchable from the workspace it was saved from."""
    if ctx.tool_name != "artifact_save":
        return
    try:
        saved = json.loads(output)
    except ValueError:
        return
    path = saved.get("source_path") if isinstance(saved, dict) else None
    if not isinstance(path, str) or not path:
        return
    from omnigent.runner.knowledge.runtime import notify_saved

    notify_saved(path)


FEATURE = Feature(
    name="knowledge",
    tools=_tools,
    handlers=dict.fromkeys((*KNOWLEDGE_TOOL_NAMES, *_INTERNAL_OPS), handle_knowledge_tool),
    on_result=_on_result,
    install=_install,
)
