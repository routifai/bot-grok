"""Objectives (goals): a plan of tasks a Super Chat owns and Helpers advance.

Layout: ``routes`` (``/v1/objectives``), ``tools`` (tool defs), ``handlers`` (runner side). The
store stays in ``omnigent.stores.objective_store``: the scheduler (``server/scheduled/fire.py``)
and the CLI consume it too. Imports stay lazy so importing a submodule never loads the server.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING

from omnigent.superchat.feature import (
    Feature,
    InstallDeps,
    ToolManagerCtx,
    is_helper,
    is_super_chat,
)
from omnigent.superchat.goals.handlers import handle_objective_tool
from omnigent.superchat.goals.tools import OBJECTIVE_TOOL_NAMES

if TYPE_CHECKING:
    from fastapi import FastAPI

    from omnigent.tools.base import Tool


def _tools(labels: Mapping[str, str] | None, _ctx: ToolManagerCtx) -> list[Tool]:
    """Super Chat gets all five; a Helper only read, task progress and propose."""
    from omnigent.superchat.goals.tools import (
        ObjectiveCreateTool,
        ObjectiveGetTool,
        ObjectiveListTool,
        ObjectiveProposeTool,
        ObjectiveUpdateTaskTool,
    )

    tools: list[Tool] = [ObjectiveGetTool(), ObjectiveUpdateTaskTool(), ObjectiveProposeTool()]
    if is_super_chat(labels):
        return [*tools, ObjectiveCreateTool(), ObjectiveListTool()]
    return tools if is_helper(labels) else []


def _install(app: FastAPI, deps: InstallDeps) -> None:
    from omnigent.superchat.goals.routes import create_objectives_router

    if deps.objective_store is None:
        return
    app.include_router(
        create_objectives_router(
            deps.objective_store,
            scheduled_task_store=deps.scheduled_task_store,
            agent_store=deps.agent_store,
            conversation_store=deps.conversation_store,
            permission_store=deps.permission_store,
            agent_cache=deps.agent_cache,
            auth_provider=deps.auth_provider,
        ),
        prefix="/v1",
        tags=["objectives"],
    )


FEATURE = Feature(
    name="objectives",
    tools=_tools,
    handlers=dict.fromkeys(OBJECTIVE_TOOL_NAMES, handle_objective_tool),
    install=_install,
)
