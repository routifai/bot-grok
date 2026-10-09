"""Knowledge: a person's own file search (a small RAG over what they uploaded or the Muse saved).

Layout: ``chunking`` / ``parse`` / ``pdf`` (text and page renders, no ML), ``store`` (index jobs
and the ``file_chunks`` table), ``vectors`` / ``index`` (the per-user txtai hybrid index),
``service`` (the indexing pass and search), ``worker`` (the background job), ``routes``
(``/v1/knowledge``), ``tools`` / ``handlers`` (``files_search`` / ``files_read_page``).

It sits on ``artifacts`` (every file it indexes is an artifact; it follows their saves and
deletes through the artifacts events) and on ``models`` (embeddings use the person's own model
connection).
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING

from omnigent.context.labels import is_superside_chat
from omnigent.superchat.feature import BackgroundJob, Feature, InstallDeps, ToolManagerCtx
from omnigent.superchat.knowledge.handlers import handle_knowledge_tool
from omnigent.superchat.knowledge.tools import KNOWLEDGE_TOOL_NAMES

if TYPE_CHECKING:
    from fastapi import FastAPI

    from omnigent.tools.base import Tool


def _tools(labels: Mapping[str, str] | None, _ctx: ToolManagerCtx) -> list[Tool]:
    """The Super Chat and its Helpers search the person's files."""
    from omnigent.superchat.knowledge.tools import FilesReadPageTool, FilesSearchTool

    if not is_superside_chat(labels):
        return []
    return [FilesSearchTool(), FilesReadPageTool()]


def _install(app: FastAPI, deps: InstallDeps) -> None:
    from omnigent.runtime import get_artifact_store
    from omnigent.superchat.artifacts import (
        SqlAlchemyArtifactStore,
        subscribe_created,
        subscribe_deleted,
    )
    from omnigent.superchat.knowledge.routes import create_knowledge_router
    from omnigent.superchat.knowledge.service import KnowledgeService
    from omnigent.superchat.knowledge.store import KnowledgeStore
    from omnigent.superchat.models import get_embeddings

    if deps.scheduled_task_store is None:
        return
    location = deps.scheduled_task_store.storage_location
    service = KnowledgeService(
        KnowledgeStore(location),
        SqlAlchemyArtifactStore(location, get_artifact_store),
        get_artifact_store,
        get_embeddings,
    )
    app.state.knowledge_service = service
    subscribe_created(service.on_created)
    subscribe_deleted(service.on_deleted)
    app.include_router(
        create_knowledge_router(service, auth_provider=deps.auth_provider),
        prefix="/v1",
        tags=["knowledge"],
    )


def _jobs(app: FastAPI) -> list[BackgroundJob]:
    """The indexing worker, once the service is installed."""
    from omnigent.superchat.knowledge.worker import IndexWorker

    service = getattr(app.state, "knowledge_service", None)
    if service is None:
        return []
    worker = IndexWorker(service)
    app.state.knowledge_worker = worker
    return [worker]


FEATURE = Feature(
    name="knowledge",
    tools=_tools,
    handlers=dict.fromkeys(KNOWLEDGE_TOOL_NAMES, handle_knowledge_tool),
    install=_install,
    jobs=_jobs,
)
