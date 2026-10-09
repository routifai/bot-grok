"""Taught skills: recordings, their keyframes and the skills drafted from them.

Layout: ``doc`` (pure draft-document functions), ``teach`` (recording + distillation), ``store``,
``routes`` (``/v1/taught-skills``), ``tools`` (tool defs), ``handlers`` (runner side). Imports
stay lazy so importing a submodule never loads the server.
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
from omnigent.superchat.skills.handlers import handle_taught_skill_tool
from omnigent.superchat.skills.tools import SKILL_TOOL_NAMES

if TYPE_CHECKING:
    from fastapi import FastAPI

    from omnigent.tools.base import Tool


def _tools(labels: Mapping[str, str] | None, _ctx: ToolManagerCtx) -> list[Tool]:
    """A Super Chat lists and runs saved skills; a Helper only saves a draft."""
    from omnigent.superchat.skills.tools import (
        SkillDraftSaveTool,
        SkillListTool,
        SkillRunTool,
    )

    if is_helper(labels):
        return [SkillDraftSaveTool()]
    if is_super_chat(labels):
        return [SkillListTool(), SkillRunTool()]
    return []


def _install(app: FastAPI, deps: InstallDeps) -> None:
    from omnigent.superchat.skills.routes import create_taught_skills_router
    from omnigent.superchat.skills.store import SqlAlchemyTaughtSkillStore

    if deps.scheduled_task_store is None:
        return
    taught_skill_store = SqlAlchemyTaughtSkillStore(deps.scheduled_task_store.storage_location)
    app.state.taught_skill_store = taught_skill_store
    app.include_router(
        create_taught_skills_router(taught_skill_store, auth_provider=deps.auth_provider),
        prefix="/v1",
        tags=["taught_skills"],
    )


FEATURE = Feature(
    name="taught_skills",
    tools=_tools,
    handlers=dict.fromkeys(SKILL_TOOL_NAMES, handle_taught_skill_tool),
    install=_install,
)
