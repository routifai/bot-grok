"""Registration of the organization admin routes."""

from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING

from omnigent.superchat.feature import Feature, InstallDeps, ToolManagerCtx

if TYPE_CHECKING:
    from fastapi import FastAPI

    from omnigent.tools.base import Tool


def _tools(_labels: Mapping[str, str] | None, _ctx: ToolManagerCtx) -> list[Tool]:
    """No model-facing tools: administration is for people, not the model."""
    return []


def _install(app: FastAPI, deps: InstallDeps) -> None:
    from omnigent.superchat.admin.routes import create_org_admin_router

    state = app.state
    # The stores are built by the ``models`` feature (registered first); without them there is
    # nothing to administer (no database behind the server).
    if not hasattr(state, "model_budgets"):
        return
    app.include_router(
        create_org_admin_router(
            overlay=state.model_org_overlay,
            suspensions=state.model_suspensions,
            budgets=state.model_budgets,
            connections=state.model_connection_store,
            conversation_store=deps.conversation_store,
            scheduled_task_store=deps.scheduled_task_store,
            auth_provider=deps.auth_provider,
            permission_store=deps.permission_store,
        ),
        prefix="/v1",
        tags=["org-admin"],
    )


FEATURE = Feature(name="admin", tools=_tools, install=_install)
