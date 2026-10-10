"""Model selection: the caller's model catalog per harness and their default model per harness.

``GET /v1/me/models?harness=<h>`` lists what the caller's connection serves on that harness (the
same catalog a new managed session validates against). ``GET``/``PUT /v1/me/model-preferences``
keep the person's default model per harness in the generic ``preferences`` table. A new session
picks: explicit model, then this default when the catalog still serves it, then the catalog default
(the organization's pick, else the connection's own first model; see
:func:`omnigent.server.routes.sandbox_inference.selected_catalog_model`).
``GET /v1/me/model-providers`` lists the providers a key can be saved for on this deployment.
``GET /v1/sessions/{id}/helper-models?harness=<h>`` answers a Computer's runner which model the
organization picked for the ``fast`` and ``strong`` Helper tiers.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel, ConfigDict

from omnigent.db.db_models import SqlPreference, current_workspace_id
from omnigent.db.utils import (
    get_or_create_engine,
    make_named_managed_session_maker,
    run_write_transaction,
)
from omnigent.errors import ErrorCode, OmnigentError
from omnigent.inference_config import normalize_inference_harness
from omnigent.server.auth import LEVEL_READ, RESERVED_USER_LOCAL, AuthProvider
from omnigent.server.routes._auth_helpers import (
    get_user_id,
    require_access_and_level,
    require_user,
)

PREFERENCE_KEY = "model_defaults"


class ModelPreferenceStore:
    """``{harness: model}`` per person, one JSON row in the ``preferences`` table."""

    def __init__(self, storage_location: str) -> None:
        engine = get_or_create_engine(storage_location)
        prefix = "omnigent.model_preferences"
        self._session = make_named_managed_session_maker(engine, query_name_prefix=prefix)
        self._session_immediate = make_named_managed_session_maker(
            engine, query_name_prefix=prefix, immediate=True
        )

    def get(self, owner: str) -> dict[str, str]:
        """The person's defaults; empty when never chosen or unreadable."""
        with self._session("select_model_defaults") as session:
            row = session.get(SqlPreference, (current_workspace_id(), owner, PREFERENCE_KEY))
            raw = row.value if row is not None else None
        try:
            value = json.loads(raw) if raw else {}
        except ValueError:
            return {}
        if not isinstance(value, dict):
            return {}
        return {k: v for k, v in value.items() if isinstance(k, str) and isinstance(v, str)}

    def set(self, owner: str, defaults: dict[str, str]) -> None:
        """Replace the person's defaults; an empty map removes the row."""

        def write(session: Any) -> None:
            pk = (current_workspace_id(), owner, PREFERENCE_KEY)
            row = session.get(SqlPreference, pk)
            if not defaults:
                if row is not None:
                    session.delete(row)
            elif row is None:
                session.add(
                    SqlPreference(user_id=owner, key=PREFERENCE_KEY, value=json.dumps(defaults))
                )
            else:
                row.value = json.dumps(defaults)

        run_write_transaction(self._session_immediate, "upsert_model_defaults", write)


def _deployment_upstreams(request: Request) -> set[str] | None:
    """The upstreams the deployment's ``connection: model`` providers are narrowed to (their
    ``upstreams`` lists), or ``None`` when any of them may use every upstream."""
    deployment = getattr(request.app.state, "sandbox_config", None)
    target = deployment.for_provider(None) if deployment is not None else None
    providers = ((target.host_config or {}).get("providers") or {}) if target is not None else {}
    lists = [
        entry.get("upstreams")
        for entry in providers.values()
        if isinstance(entry, dict) and entry.get("connection") == "model"
    ]
    if not lists or not all(isinstance(only, list) for only in lists):
        return None
    return {name for only in lists for name in only}


class ModelPreferencesBody(BaseModel):
    """Body of ``PUT /v1/me/model-preferences``: replaces the whole map."""

    model_config = ConfigDict(extra="forbid")

    defaults: dict[str, str]


def create_model_selection_router(
    store: ModelPreferenceStore,
    *,
    auth_provider: AuthProvider | None = None,
    permission_store: Any = None,
    conversation_store: Any = None,
) -> APIRouter:
    """``/me/models``, ``/me/model-preferences``, ``/me/model-providers`` and
    ``/sessions/{id}/helper-models`` (mount with ``prefix="/v1"``)."""
    from omnigent.server.inference_catalog import catalog_row_details
    from omnigent.server.routes.sandbox_inference import preview_inference
    from omnigent.superchat.models.tiers import tier_models
    from omnigent.superchat.models.upstreams import offered_providers

    router = APIRouter()

    @router.get("/me/model-providers")
    async def list_providers(request: Request) -> dict[str, Any]:
        """The providers a key can be saved for here, best first (the engine's registry, kept
        to the upstreams the deployment's model connections may use)."""
        require_user(request, auth_provider)
        return {"object": "list", "data": offered_providers(_deployment_upstreams(request))}

    @router.get("/sessions/{session_id}/helper-models")
    async def helper_models(request: Request, session_id: str, harness: str) -> dict[str, Any]:
        """``{"fast": id | null, "strong": id | null}``: the organization's Helper tier picks
        for *harness*, for a Helper dispatched from this session (``null`` = not chosen: the
        Helper inherits the session's model)."""
        if conversation_store is not None:
            await require_access_and_level(
                get_user_id(request, auth_provider),
                session_id,
                LEVEL_READ,
                permission_store,
                conversation_store,
            )
        return await asyncio.to_thread(tier_models, normalize_inference_harness(harness))

    @router.get("/me/models")
    async def list_models(
        request: Request, harness: str, sandbox_provider: str | None = None
    ) -> dict[str, Any]:
        """The caller's catalog for *harness*, with the org and personal defaults flagged."""
        user_id = require_user(request, auth_provider)
        harness = normalize_inference_harness(harness)
        snapshot, catalog = await preview_inference(request, sandbox_provider, harness, user_id)
        mine = (await asyncio.to_thread(store.get, user_id or RESERVED_USER_LOCAL)).get(harness)
        rows = [
            {
                "id": row["id"],
                "label": row.get("displayName") or row["id"],
                **(catalog_row_details(snapshot, row["id"]) if snapshot is not None else {}),
                "is_default": bool(row.get("isDefault")),
                "is_user_default": row["id"] == mine,
            }
            for row in catalog["models"]
        ]
        response: dict[str, Any] = {
            "harness": harness,
            "status": catalog["status"],
            "provider_label": catalog["provider_label"],
            "default_model": catalog["default_model"],
            "models": rows,
        }
        if catalog.get("error"):
            response["error"] = catalog["error"]
        return response

    @router.get("/me/model-preferences")
    async def get_preferences(request: Request) -> dict[str, Any]:
        user_id = require_user(request, auth_provider)
        return {"defaults": await asyncio.to_thread(store.get, user_id or RESERVED_USER_LOCAL)}

    @router.put("/me/model-preferences")
    async def put_preferences(request: Request, body: ModelPreferencesBody) -> dict[str, Any]:
        """Set the defaults; each model must be in the caller's catalog for its harness.

        ``MODEL_NOT_SUPPORTED`` when the caller's connection does not serve the model;
        ``INVALID_INPUT`` when the harness has no usable catalog for the caller.
        """
        user_id = require_user(request, auth_provider)
        defaults: dict[str, str] = {}
        for raw_harness, model in body.defaults.items():
            harness = normalize_inference_harness(raw_harness)
            _, catalog = await preview_inference(request, None, harness, user_id)
            if catalog["status"] != "ready":
                raise OmnigentError(
                    catalog.get("error") or f"No models are available for harness {harness!r}",
                    code=ErrorCode.INVALID_INPUT,
                )
            if model not in {row["id"] for row in catalog["models"]}:
                raise OmnigentError(
                    f"Model {model!r} is not served by your connection for {harness!r}",
                    code=ErrorCode.MODEL_NOT_SUPPORTED,
                )
            defaults[harness] = model
        await asyncio.to_thread(store.set, user_id or RESERVED_USER_LOCAL, defaults)
        return {"defaults": defaults}

    return router
