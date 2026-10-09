"""Model connections: encrypted provider API keys, per user or per organization.

Layout: ``upstreams`` (the provider registry), ``store`` (SQLAlchemy store, sealed with the vault's
AES-GCM), ``probe`` (one cheap validation call), ``routes`` (``/v1/me/model-connections`` and
``/v1/admin/model-connections``), ``budget``/``budget_routes`` (monthly limits and
``/v1/me/budget``, ``/v1/admin/budget``), ``org``/``admin_routes`` (model overlay, suspension,
``/v1/admin/{models,users,usage}``), ``spend`` (what a proxied call cost), ``proxy`` (the
engine model proxy). The key goes in once, is
probed, sealed and never shown back; the run path reads it server-side through
:func:`omnigent.model_credentials.store.resolve_model_connection`.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING

from omnigent.superchat.feature import Feature, InstallDeps, ToolManagerCtx

if TYPE_CHECKING:
    from fastapi import FastAPI

    from omnigent.tools.base import Tool


def _tools(_labels: Mapping[str, str] | None, _ctx: ToolManagerCtx) -> list[Tool]:
    """No model-facing tools: the key never reaches the model."""
    return []


def _install(app: FastAPI, deps: InstallDeps) -> None:
    from omnigent.model_credentials.routes import create_model_connection_router
    from omnigent.model_credentials.store import ModelConnectionStore

    if deps.scheduled_task_store is None:
        return
    store = ModelConnectionStore(deps.scheduled_task_store.storage_location)
    app.state.model_connection_store = store
    from omnigent.model_credentials.selection import (
        ModelPreferenceStore,
        create_model_selection_router,
    )

    preferences = ModelPreferenceStore(deps.scheduled_task_store.storage_location)
    app.state.model_preference_store = preferences
    app.include_router(
        create_model_selection_router(preferences, auth_provider=deps.auth_provider),
        prefix="/v1",
        tags=["model-selection"],
    )
    from omnigent.model_credentials.budget import ModelBudgets, ModelBudgetStore, bind_budgets
    from omnigent.model_credentials.budget_routes import create_budget_router

    budgets = ModelBudgets(
        ModelBudgetStore(deps.scheduled_task_store.storage_location), deps.conversation_store
    )
    app.state.model_budgets = budgets
    bind_budgets(budgets)
    app.include_router(
        create_budget_router(
            budgets, auth_provider=deps.auth_provider, permission_store=deps.permission_store
        ),
        prefix="/v1",
        tags=["model-budget"],
    )
    from omnigent.model_credentials.admin_routes import create_org_admin_router
    from omnigent.model_credentials.org import (
        ModelOrgOverlayStore,
        SuspensionStore,
        bind_suspensions,
    )

    overlay = ModelOrgOverlayStore(deps.scheduled_task_store.storage_location)
    suspensions = SuspensionStore(deps.scheduled_task_store.storage_location)
    app.state.model_org_overlay = overlay
    bind_suspensions(suspensions)
    app.include_router(
        create_org_admin_router(
            overlay=overlay,
            suspensions=suspensions,
            budgets=budgets,
            connections=store,
            conversation_store=deps.conversation_store,
            scheduled_task_store=deps.scheduled_task_store,
            auth_provider=deps.auth_provider,
            permission_store=deps.permission_store,
        ),
        prefix="/v1",
        tags=["org-admin"],
    )
    app.include_router(
        create_model_connection_router(
            store, auth_provider=deps.auth_provider, permission_store=deps.permission_store
        ),
        prefix="/v1",
        tags=["model-connections"],
    )


FEATURE = Feature(name="model_credentials", tools=_tools, install=_install)
