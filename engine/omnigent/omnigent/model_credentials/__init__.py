"""Model connections: encrypted provider API keys, per user or per organization.

Layout: ``upstreams`` (the provider registry), ``store`` (SQLAlchemy store, sealed with the vault's
AES-GCM), ``probe`` (one cheap validation call), ``routes`` (``/v1/me/model-connections`` and
``/v1/admin/model-connections``), ``proxy`` (the engine model proxy). The key goes in once, is
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
    app.include_router(
        create_model_connection_router(
            store, auth_provider=deps.auth_provider, permission_store=deps.permission_store
        ),
        prefix="/v1",
        tags=["model-connections"],
    )


FEATURE = Feature(name="model_credentials", tools=_tools, install=_install)
