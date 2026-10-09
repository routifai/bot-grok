"""Registration of the artifacts primitive (tools, REST routes, delete approval)."""

from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any

from omnigent.context.labels import is_superside_chat
from omnigent.superchat.artifacts.handlers import handle_artifact_tool
from omnigent.superchat.artifacts.tools import ARTIFACT_TOOL_NAMES
from omnigent.superchat.artifacts.writeback import deliver_manual_edits
from omnigent.superchat.feature import Feature, InstallDeps, ToolManagerCtx
from omnigent.superchat.risk import Risk, register_classifier

if TYPE_CHECKING:
    from fastapi import FastAPI

    from omnigent.tools.base import Tool


def _classify_delete(tool_name: str, arguments: Mapping[str, Any]) -> Risk | None:
    """``artifact_delete`` is a ``delete``-category action: the person is always asked."""
    base = tool_name.rsplit("__", 1)[-1]
    if base != "artifact_delete":
        return None
    target = str(arguments.get("artifact_id") or "a saved file")
    return Risk("delete", (f"artifact:{target}",), "Delete a saved file and all its versions")


register_classifier(_classify_delete)


def _tools(labels: Mapping[str, str] | None, _ctx: ToolManagerCtx) -> list[Tool]:
    """Offered to the Super Chat and to Helpers alike (a Helper saves under its parent)."""
    from omnigent.superchat.artifacts.tools import (
        ArtifactDeleteTool,
        ArtifactListTool,
        ArtifactSaveTool,
    )

    if not is_superside_chat(labels):
        return []
    return [ArtifactSaveTool(), ArtifactListTool(), ArtifactDeleteTool()]


def _install(app: FastAPI, deps: InstallDeps) -> None:
    from omnigent.runtime import get_artifact_store
    from omnigent.superchat.artifacts.routes import create_artifacts_router
    from omnigent.superchat.artifacts.store import SqlAlchemyArtifactStore

    if deps.scheduled_task_store is None:
        return
    app.include_router(
        create_artifacts_router(
            SqlAlchemyArtifactStore(
                deps.scheduled_task_store.storage_location, get_artifact_store
            ),
            conversation_store=deps.conversation_store,
            permission_store=deps.permission_store,
            auth_provider=deps.auth_provider,
        ),
        prefix="/v1",
        tags=["artifacts"],
    )


ARTIFACTS_FEATURE = Feature(
    name="artifacts",
    tools=_tools,
    handlers=dict.fromkeys(ARTIFACT_TOOL_NAMES, handle_artifact_tool),
    turn_prefix=deliver_manual_edits,
    install=_install,
)
