"""Registration of live artifacts (tools, routes, the fire-path hook)."""

from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING

from omnigent.server.scheduled.helper_fire import register_fire_deferral
from omnigent.superchat.feature import (
    Feature,
    InstallDeps,
    ToolManagerCtx,
    is_helper,
    is_super_chat,
)
from omnigent.superchat.live.handlers import handle_live_tool
from omnigent.superchat.live.service import LIVE_TASK_KIND
from omnigent.superchat.live.tools import HELPER_TOOL_NAMES, SUPER_CHAT_TOOL_NAMES

if TYPE_CHECKING:
    from fastapi import FastAPI

    from omnigent.tools.base import Tool


def _tools(labels: Mapping[str, str] | None, _ctx: ToolManagerCtx) -> list[Tool]:
    """The schedule tools for the Super Chat; the update tools for its Helpers."""
    from omnigent.superchat.live.tools import (
        KeepUpdatedTool,
        StopUpdatingTool,
        UpdateCheckedTool,
        UpdateContextTool,
        UpdateSaveTool,
    )

    if is_super_chat(labels):
        return [KeepUpdatedTool(), StopUpdatingTool()]
    if is_helper(labels):
        return [UpdateContextTool(), UpdateSaveTool(), UpdateCheckedTool()]
    return []


def _install(app: FastAPI, deps: InstallDeps) -> None:
    from omnigent.runtime import get_artifact_store
    from omnigent.superchat.artifacts.store import SqlAlchemyArtifactStore
    from omnigent.superchat.live.routes import create_live_router
    from omnigent.superchat.live.service import LiveService
    from omnigent.superchat.live.store import SqlAlchemyLiveStore

    if deps.scheduled_task_store is None:
        return
    location = deps.scheduled_task_store.storage_location
    service = LiveService(
        SqlAlchemyArtifactStore(location, get_artifact_store),
        SqlAlchemyLiveStore(location),
        deps.scheduled_task_store,
        deps.conversation_store,
        lambda: getattr(app.state, "scheduled_task_scheduler", None),
    )
    register_fire_deferral(LIVE_TASK_KIND, service.defer_until)
    app.include_router(
        create_live_router(
            service,
            conversation_store=deps.conversation_store,
            permission_store=deps.permission_store,
            auth_provider=deps.auth_provider,
        ),
        prefix="/v1",
        tags=["artifacts"],
    )


LIVE_FEATURE = Feature(
    name="live",
    tools=_tools,
    handlers=dict.fromkeys((*SUPER_CHAT_TOOL_NAMES, *HELPER_TOOL_NAMES), handle_live_tool),
    install=_install,
)
