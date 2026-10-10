"""Model selection: the caller's catalog per harness and their Default and Light picks.

``GET /v1/me/models?harness=<h>`` lists what the caller's connection serves on that harness (the
same catalog a new managed session validates against), with their Default and Light flagged.
``GET``/``PUT /v1/me/model-preferences`` keep the person's picks per harness in the generic
``preferences`` table. A new session picks: explicit model, then the person's Default when the
catalog still serves it, then the catalog default (the connection's own; see
:func:`omnigent.server.routes.sandbox_inference.selected_catalog_model`). Light is resolved in
:mod:`omnigent.superchat.models.tiers`.
``GET /v1/me/model-providers`` lists the providers a key can be saved for on this deployment.
``GET /v1/sessions/{id}/helper-models?harness=<h>`` answers a Computer's runner which model the
``fast`` (Light) and ``strong`` (Default) Helper choices run on for the session's owner.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
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


def _model_map(raw: Any) -> dict[str, str]:
    if not isinstance(raw, dict):
        return {}
    return {k: v for k, v in raw.items() if isinstance(k, str) and isinstance(v, str) and v}


@dataclass(frozen=True)
class ModelPicks:
    """A person's own picks, ``{harness: model}`` each: ``defaults`` and ``light``."""

    defaults: dict[str, str] = field(default_factory=dict)
    light: dict[str, str] = field(default_factory=dict)


class ModelPreferenceStore:
    """A person's Default and Light picks per harness, one JSON row in ``preferences``.

    Stored as ``{"defaults": {harness: model}, "light": {harness: model}}``; a row written
    before Light existed is a bare ``{harness: model}`` map of defaults.
    """

    def __init__(self, storage_location: str) -> None:
        engine = get_or_create_engine(storage_location)
        prefix = "omnigent.model_preferences"
        self._session = make_named_managed_session_maker(engine, query_name_prefix=prefix)
        self._session_immediate = make_named_managed_session_maker(
            engine, query_name_prefix=prefix, immediate=True
        )

    def read(self, owner: str) -> ModelPicks:
        """The person's picks; empty when never chosen or unreadable."""
        with self._session("select_model_defaults") as session:
            row = session.get(SqlPreference, (current_workspace_id(), owner, PREFERENCE_KEY))
            raw = row.value if row is not None else None
        try:
            value = json.loads(raw) if raw else {}
        except ValueError:
            return ModelPicks()
        if isinstance(value, dict) and ("defaults" in value or "light" in value):
            return ModelPicks(_model_map(value.get("defaults")), _model_map(value.get("light")))
        return ModelPicks(defaults=_model_map(value))

    def get(self, owner: str) -> dict[str, str]:
        """The person's default model per harness."""
        return self.read(owner).defaults

    def set(
        self, owner: str, defaults: dict[str, str], light: dict[str, str] | None = None
    ) -> None:
        """Replace the person's defaults and, unless *light* is ``None``, their Light picks.

        Nothing picked at all removes the row.
        """

        def write(session: Any) -> None:
            pk = (current_workspace_id(), owner, PREFERENCE_KEY)
            row = session.get(SqlPreference, pk)
            kept = light
            if kept is None:
                try:
                    old = json.loads(row.value) if row is not None else {}
                except ValueError:
                    old = {}
                kept = _model_map(old.get("light")) if isinstance(old, dict) else {}
            value = json.dumps({"defaults": defaults, "light": kept})
            if not defaults and not kept:
                if row is not None:
                    session.delete(row)
            elif row is None:
                session.add(SqlPreference(user_id=owner, key=PREFERENCE_KEY, value=value))
            else:
                row.value = value

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
    """Body of ``PUT /v1/me/model-preferences``: each map given replaces the stored one; an
    omitted map is kept."""

    model_config = ConfigDict(extra="forbid")

    defaults: dict[str, str] | None = None
    light: dict[str, str] | None = None


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
    from omnigent.superchat.models.tiers import person_models_from_catalog, tier_models
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
        """``{"fast": id | null, "strong": id | null}``: the session owner's Light and Default
        on *harness*, for a Helper dispatched from this session (``null``: no usable catalog,
        the Helper inherits the session's model)."""
        owner = None
        if conversation_store is not None:
            await require_access_and_level(
                get_user_id(request, auth_provider),
                session_id,
                LEVEL_READ,
                permission_store,
                conversation_store,
            )
            owner_of = getattr(conversation_store, "get_session_owner", None)
            owner = await asyncio.to_thread(owner_of, session_id) if owner_of else None
        return await tier_models(request.app.state, owner, normalize_inference_harness(harness))

    @router.get("/me/models")
    async def list_models(
        request: Request, harness: str, sandbox_provider: str | None = None
    ) -> dict[str, Any]:
        """The caller's catalog for *harness*, with their Default and Light flagged.

        ``light_model`` is what Light resolves to, ``light_pick`` the caller's own pick
        (``null``: automatic) and ``automatic_light_model`` what automatic means right now.
        """
        user_id = require_user(request, auth_provider)
        harness = normalize_inference_harness(harness)
        snapshot, catalog = await preview_inference(request, sandbox_provider, harness, user_id)
        picks = await asyncio.to_thread(store.read, user_id or RESERVED_USER_LOCAL)
        mine = picks.defaults.get(harness)
        resolved = await asyncio.to_thread(
            person_models_from_catalog,
            catalog,
            default_pick=mine,
            light_pick=picks.light.get(harness),
        )
        rows = [
            {
                "id": row["id"],
                "label": row.get("displayName") or row["id"],
                **(catalog_row_details(snapshot, row["id"]) if snapshot is not None else {}),
                "is_default": bool(row.get("isDefault")),
                "is_user_default": row["id"] == mine,
                "is_light": row["id"] == resolved.light,
            }
            for row in catalog["models"]
        ]
        response: dict[str, Any] = {
            "harness": harness,
            "status": catalog["status"],
            "provider_label": catalog["provider_label"],
            "default_model": catalog["default_model"],
            "light_model": resolved.light,
            "light_pick": resolved.light_pick,
            "automatic_light_model": resolved.automatic_light,
            "models": rows,
        }
        if catalog.get("error"):
            response["error"] = catalog["error"]
        return response

    def _picks_body(picks: ModelPicks) -> dict[str, Any]:
        return {"defaults": picks.defaults, "light": picks.light}

    @router.get("/me/model-preferences")
    async def get_preferences(request: Request) -> dict[str, Any]:
        user_id = require_user(request, auth_provider)
        return _picks_body(await asyncio.to_thread(store.read, user_id or RESERVED_USER_LOCAL))

    async def _validated(request: Request, user_id: str | None, raw: dict[str, str]) -> dict:
        """*raw* keyed by normalized harness, each model checked against the caller's catalog.

        ``MODEL_NOT_SUPPORTED`` when the caller's connection does not serve the model;
        ``INVALID_INPUT`` when the harness has no usable catalog for the caller.
        """
        picked: dict[str, str] = {}
        for raw_harness, model in raw.items():
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
            picked[harness] = model
        return picked

    @router.put("/me/model-preferences")
    async def put_preferences(request: Request, body: ModelPreferencesBody) -> dict[str, Any]:
        """Set the Default and/or Light picks (a map left out is kept as it is)."""
        user_id = require_user(request, auth_provider)
        owner = user_id or RESERVED_USER_LOCAL
        current = await asyncio.to_thread(store.read, owner)
        defaults = (
            current.defaults
            if body.defaults is None
            else await _validated(request, user_id, body.defaults)
        )
        light = None if body.light is None else await _validated(request, user_id, body.light)
        await asyncio.to_thread(store.set, owner, defaults, light)
        return _picks_body(await asyncio.to_thread(store.read, owner))

    return router
