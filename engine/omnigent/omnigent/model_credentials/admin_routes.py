"""Organization admin routes (``/v1/admin/...``), admin-only; the organization is the workspace.

* ``GET``/``PUT /admin/models``: the model overlay ``{harnesses: {h: {allow, default}}}`` that
  narrows what each harness's connection binding offers (see :mod:`...model_credentials.org`).
* ``GET /admin/models/catalog?harness=``: the binding's full model list the overlay narrows.
* ``GET /admin/users``: every person with role, status, spend, sessions, connections, budget and
  Computer; ``GET /admin/usage?window=day|month``: org totals, per-person and per-day.
* ``POST /admin/users/{id}/suspend`` and ``/resume``: stop and restore a person's usage.
* ``DELETE /admin/users/{id}``: remove a person and what they own.

The budget (``/admin/budget``) and the organization's connections (``/admin/model-connections``)
live in their own modules; this file only reads them.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx
from fastapi import APIRouter, Request
from pydantic import BaseModel, ConfigDict

from omnigent.db.utils import utc_day
from omnigent.errors import ErrorCode, OmnigentError
from omnigent.inference_config import normalize_inference_harness
from omnigent.model_credentials import budget as budget_module
from omnigent.model_credentials.budget import ModelBudgets
from omnigent.model_credentials.org import (
    ModelOrgOverlayStore,
    Overlay,
    SuspensionStore,
)
from omnigent.model_credentials.store import SCOPE_USER, ModelConnectionStore
from omnigent.server.auth import (
    RESERVED_USER_LOCAL,
    RESERVED_USER_PUBLIC,
    RESERVED_USER_WORKSPACE,
    AuthProvider,
)
from omnigent.server.routes._auth_helpers import require_admin

_logger = logging.getLogger(__name__)
_RESERVED = frozenset({RESERVED_USER_LOCAL, RESERVED_USER_PUBLIC, RESERVED_USER_WORKSPACE})
_ADMIN_MESSAGE = "Admin privileges required to manage the organization"
_PAGE = 200
_WINDOWS = ("day", "month")


class OverlayEntry(BaseModel):
    """One harness's overlay: ``allow`` (``null`` = no restriction) and ``default`` model."""

    model_config = ConfigDict(extra="forbid")

    allow: list[str] | None = None
    default: str | None = None


class PutOverlay(BaseModel):
    """Body of ``PUT /admin/models``: replaces the whole overlay."""

    model_config = ConfigDict(extra="forbid")

    harnesses: dict[str, OverlayEntry]


def _invalid(message: str) -> OmnigentError:
    return OmnigentError(message, code=ErrorCode.INVALID_INPUT)


def create_org_admin_router(
    *,
    overlay: ModelOrgOverlayStore,
    suspensions: SuspensionStore,
    budgets: ModelBudgets,
    connections: ModelConnectionStore,
    conversation_store: Any,
    scheduled_task_store: Any = None,
    auth_provider: AuthProvider | None = None,
    permission_store: Any = None,
) -> APIRouter:
    """Build the router, mounted with ``prefix="/v1"``."""
    router = APIRouter()

    async def _admin(request: Request) -> str | None:
        return await require_admin(
            request, auth_provider, permission_store, message=_ADMIN_MESSAGE
        )

    def _require_directory() -> Any:
        if permission_store is None:
            raise OmnigentError("This server has no user directory", code=ErrorCode.NOT_FOUND)
        return permission_store

    def _account(target: str) -> Any:
        account = _require_directory().get_user(target) if target not in _RESERVED else None
        if account is None:
            raise OmnigentError("User not found", code=ErrorCode.NOT_FOUND)
        return account

    def _other_active_admins(target: str) -> list[str]:
        gone = suspensions.suspended_since()
        return [
            u.id
            for u in _require_directory().list_users()
            if u.is_admin and u.id != target and u.id not in gone
        ]

    # ---- model overlay -------------------------------------------------------------------

    @router.get("/admin/models")
    async def get_models(request: Request) -> dict[str, Any]:
        await _admin(request)
        return {"harnesses": await asyncio.to_thread(overlay.get)}

    @router.put("/admin/models")
    async def put_models(request: Request, body: PutOverlay) -> dict[str, Any]:
        """Replace the overlay. Every model must be served by the harness's binding.

        ``INVALID_INPUT`` for an empty allowlist, a default outside the allowlist or a harness
        with no managed binding; ``MODEL_NOT_SUPPORTED`` for a model the binding cannot serve.
        """
        admin_id = await _admin(request)
        from omnigent.server.routes.sandbox_inference import inference_service

        result: Overlay = {}
        for raw_harness, entry in body.harnesses.items():
            harness = normalize_inference_harness(raw_harness)
            if entry.allow is None and entry.default is None:
                continue
            if entry.allow is not None and not entry.allow:
                raise _invalid("allow must list at least one model, or be null for no restriction")
            if entry.allow is not None and entry.default and entry.default not in entry.allow:
                raise _invalid(f"default for {harness!r} must be one of its allowed models")
            try:  # the bare binding, as the admin's own connection resolves it
                snapshot = await inference_service(request).prepare(
                    None, harness, admin_id, org_overlay=False
                )
            except (OmnigentError, ValueError) as exc:
                raise _invalid(
                    exc.message if isinstance(exc, OmnigentError) else "Invalid configuration"
                ) from None
            catalog = snapshot["catalog"] if snapshot is not None else None
            if catalog is None or catalog["status"] != "ready":
                raise _invalid(
                    (catalog or {}).get("error")
                    or f"No models are managed for harness {harness!r}"
                )
            served = {row["id"] for row in catalog["models"]}
            for model in [*(entry.allow or []), *([entry.default] if entry.default else [])]:
                if model not in served:
                    raise OmnigentError(
                        f"Model {model!r} is not served for {harness!r}",
                        code=ErrorCode.MODEL_NOT_SUPPORTED,
                    )
            result[harness] = {
                "allow": list(dict.fromkeys(entry.allow)) if entry.allow is not None else None,
                "default": entry.default,
            }
        await asyncio.to_thread(overlay.set, result)
        return {"harnesses": result}

    @router.get("/admin/models/catalog")
    async def get_models_catalog(request: Request, harness: str) -> dict[str, Any]:
        """The harness binding's full model list, before the overlay narrows it.

        What the overlay editor picks from: ``GET /me/models`` already shows the narrowed list.
        """
        admin_id = await _admin(request)
        from omnigent.server.inference_catalog import catalog_row_details
        from omnigent.server.routes.sandbox_inference import inference_service

        harness = normalize_inference_harness(harness)
        try:
            snapshot = await inference_service(request).prepare(
                None, harness, admin_id, org_overlay=False
            )
        except (OmnigentError, ValueError) as exc:
            raise _invalid(
                exc.message if isinstance(exc, OmnigentError) else "Invalid configuration"
            ) from None
        catalog = snapshot["catalog"] if snapshot is not None else None
        if catalog is None:
            raise _invalid(f"No models are managed for harness {harness!r}")
        return {
            "harness": harness,
            "status": catalog["status"],
            "default_model": catalog["default_model"],
            "models": [
                {
                    "id": row["id"],
                    "label": row.get("displayName") or row["id"],
                    "family": catalog_row_details(snapshot, row["id"])["family"],
                }
                for row in catalog["models"]
            ],
        }

    # ---- people and usage ----------------------------------------------------------------

    def _computer(host_store: Any, user_id: str) -> dict[str, Any] | None:
        from omnigent.stores.host_store import host_is_live

        hosts = host_store.list_hosts(user_id)
        if not hosts:
            return None
        host = hosts[0]  # most recently active first
        return {
            "host_id": host.host_id,
            "name": host.name,
            "managed": host.sandbox_provider is not None,
            "provider": host.sandbox_provider,
            "state": "online" if host_is_live(host) else "offline",
            "updated_at": host.updated_at,
        }

    def _users(host_store: Any) -> list[dict[str, Any]]:
        month, today = budget_module.month_start(), utc_day(budget_module.now_epoch())
        spend_month: dict[str, float] = {}
        spend_today: dict[str, float] = {}
        for user_id, day, cost in conversation_store.list_workspace_daily_costs(month):
            spend_month[user_id] = spend_month.get(user_id, 0.0) + cost
            if day == today:
                spend_today[user_id] = spend_today.get(user_id, 0.0) + cost
        sessions = conversation_store.owner_session_stats()
        keys = connections.list_by_user()
        suspended = suspensions.suspended_since()
        rows = []
        for account in _require_directory().list_users():
            count, latest = sessions.get(account.id, (0, 0))
            budget = budgets.store.get(account.id)
            last_active = max(account.last_login_at or 0, latest) or None
            rows.append(
                {
                    "id": account.id,
                    "email": account.id if "@" in account.id else None,
                    "is_admin": account.is_admin,
                    "created_at": account.created_at,
                    "last_login_at": account.last_login_at,
                    "last_active": last_active,
                    "status": "suspended" if account.id in suspended else "active",
                    "suspended_at": suspended.get(account.id),
                    "spend_month_usd": spend_month.get(account.id, 0.0),
                    "spend_today_usd": spend_today.get(account.id, 0.0),
                    "session_count": count,
                    "model_connections": [
                        {"provider": m.provider, "hint": m.hint, "status": m.status}
                        for m in keys.get(account.id, [])
                    ],
                    "budget": {
                        "monthly_limit_usd": budget.monthly_limit_usd,
                        "at_limit": budget.at_limit,
                    },
                    "computer": _computer(host_store, account.id) if host_store else None,
                }
            )
        return sorted(rows, key=lambda r: r["id"])

    @router.get("/admin/users")
    async def list_users(request: Request) -> dict[str, Any]:
        await _admin(request)
        if permission_store is None:
            return {"users": []}
        host_store = getattr(request.app.state, "host_store", None)
        return {"users": await asyncio.to_thread(_users, host_store)}

    @router.get("/admin/usage")
    async def usage(request: Request, window: str = "month") -> dict[str, Any]:
        """Org spend for the UTC day or month: total, per person and per day."""
        await _admin(request)
        if window not in _WINDOWS:
            raise _invalid(f"window must be one of: {', '.join(_WINDOWS)}")

        def read() -> dict[str, Any]:
            today = utc_day(budget_module.now_epoch())
            since = today if window == "day" else budget_module.month_start()
            per_user: dict[str, float] = {}
            per_day: dict[str, float] = {}
            for user_id, day, cost in conversation_store.list_workspace_daily_costs(since):
                per_user[user_id] = per_user.get(user_id, 0.0) + cost
                per_day[day] = per_day.get(day, 0.0) + cost
            org = budgets.store.get(budget_module.WORKSPACE_OWNER)
            return {
                "window": window,
                "period_start": since,
                "total_usd": sum(per_user.values()),
                "by_user": [
                    {"user_id": user_id, "cost_usd": cost}
                    for user_id, cost in sorted(per_user.items(), key=lambda kv: (-kv[1], kv[0]))
                ],
                "by_day": [
                    {"day": day, "cost_usd": cost} for day, cost in sorted(per_day.items())
                ],
                "org_budget": {
                    "monthly_limit_usd": org.monthly_limit_usd,
                    "at_limit": org.at_limit,
                },
            }

        return await asyncio.to_thread(read)

    # ---- suspend / resume ----------------------------------------------------------------

    async def _interrupt_running(request: Request, user_id: str) -> int:
        """Cancel the turns this person has running; best effort, returns how many were asked."""
        from omnigent.server.routes._sessions.common import _interrupt_fenced_sessions
        from omnigent.server.routes._sessions.helpers import (
            _get_runner_client,
            _publish_interrupted,
            _session_status_from_cache,
        )
        from omnigent.server.routes._sessions.orchestration import _best_effort_stop

        router_ = getattr(request.app.state, "runner_router", None)
        stopped, after = 0, None
        while True:
            page = await asyncio.to_thread(
                conversation_store.list_conversations,
                limit=_PAGE,
                after=after,
                kind=None,
                owned_by=user_id,
            )
            for conv in page.data:
                if _session_status_from_cache(conv.id, conv.live_status) != "running":
                    continue
                stopped += 1
                _publish_interrupted(conv.id)
                _interrupt_fenced_sessions.add(conv.id)
                try:
                    client = await _get_runner_client(conv.id, router_)
                    resp = (
                        await client.post(
                            f"/v1/sessions/{conv.id}/events",
                            json={"type": "interrupt"},
                            timeout=5.0,
                        )
                        if client is not None
                        else None
                    )
                    if resp is None or resp.status_code >= 400:
                        _interrupt_fenced_sessions.discard(conv.id)
                except (httpx.HTTPError, ConnectionError):
                    _interrupt_fenced_sessions.discard(conv.id)
                    _logger.warning("interrupt not delivered for a suspended account's session")
                await _best_effort_stop(conv.id, conversation_store, router_)
            if not page.has_more or page.last_id is None:
                return stopped
            after = page.last_id

    @router.post("/admin/users/{user_id}/suspend")
    async def suspend(request: Request, user_id: str) -> dict[str, Any]:
        """Stop a person's usage: model calls, new sessions and turns are refused."""
        admin_id = await _admin(request)
        account = await asyncio.to_thread(_account, user_id)
        if user_id == admin_id:
            raise _invalid("You cannot suspend your own account")
        if account.is_admin and not await asyncio.to_thread(_other_active_admins, user_id):
            raise _invalid("You cannot suspend the last active admin")
        await asyncio.to_thread(suspensions.suspend, user_id, admin_id)
        return {
            "id": user_id,
            "status": "suspended",
            "sessions_interrupted": await _interrupt_running(request, user_id),
        }

    @router.post("/admin/users/{user_id}/resume")
    async def resume(request: Request, user_id: str) -> dict[str, Any]:
        await _admin(request)
        await asyncio.to_thread(_account, user_id)
        await asyncio.to_thread(suspensions.resume, user_id)
        return {"id": user_id, "status": "active"}

    # ---- delete ---------------------------------------------------------------------------

    async def _delete_sessions(request: Request, user_id: str) -> int:
        """Delete the sessions the person owns, with their stored files; returns how many."""
        from omnigent.server.routes._sessions.orchestration import _best_effort_stop

        state = request.app.state
        files, blobs = getattr(state, "file_store", None), getattr(state, "artifact_store", None)
        router_, deleted = getattr(state, "runner_router", None), 0
        while True:  # the first page again each time: what was listed is gone
            page = await asyncio.to_thread(
                conversation_store.list_conversations,
                limit=_PAGE,
                kind="default",
                owned_by=user_id,
                include_archived=True,
            )
            if not page.data:
                return deleted
            for conv in page.data:
                await _best_effort_stop(conv.id, conversation_store, router_)
                if files is not None and blobs is not None:
                    for key in await asyncio.to_thread(files.delete_all_for_session, conv.id):
                        await asyncio.to_thread(blobs.delete, key)
                deleted += 1 if await conversation_store.delete_conversation(conv.id) else 0

    @router.delete("/admin/users/{user_id}")
    async def delete_user(request: Request, user_id: str) -> dict[str, Any]:
        """Delete a person: sessions, Computer, keys, preferences and the account. Idempotent.

        Refuses the caller's own account and the last admin. A person already gone is a no-op.
        """
        admin_id = await _admin(request)
        directory = _require_directory()
        if user_id in _RESERVED:
            raise OmnigentError("User not found", code=ErrorCode.NOT_FOUND)
        if user_id == admin_id:
            raise _invalid("You cannot delete your own account")
        account = await asyncio.to_thread(directory.get_user, user_id)
        if account is not None and account.is_admin:
            others = await asyncio.to_thread(
                lambda: [u for u in directory.list_users() if u.is_admin and u.id != user_id]
            )
            if not others:
                raise _invalid("You cannot delete the last admin")

        state = request.app.state
        if account is not None:  # nothing new starts while the rest is torn down
            await asyncio.to_thread(suspensions.suspend, user_id, admin_id)
        owned = (
            await asyncio.to_thread(scheduled_task_store.list, owner_user_id=user_id)
            if scheduled_task_store is not None
            else []
        )
        sessions = await _delete_sessions(request, user_id)

        hosts_stopped = 0
        host_store = getattr(state, "host_store", None)
        if host_store is not None:
            from omnigent.server.managed_hosts import terminate_managed_host

            for host in await asyncio.to_thread(host_store.list_hosts, user_id):
                if host.sandbox_provider is not None:
                    await terminate_managed_host(
                        host, host_store, getattr(state, "sandbox_config", None)
                    )
                    hosts_stopped += 1

        keys = 0
        for meta in await asyncio.to_thread(connections.list, SCOPE_USER, user_id):
            keys += int(
                await asyncio.to_thread(connections.delete, SCOPE_USER, user_id, meta.provider)
            )

        removed = False
        if account is not None:
            from omnigent.server.accounts_store import SqlAlchemyAccountStore

            accounts = SqlAlchemyAccountStore(directory.storage_location)
            removed = await asyncio.to_thread(accounts.delete_user, user_id) is True
            if removed:
                scheduler = getattr(state, "scheduled_task_scheduler", None)
                for task in owned:
                    if scheduler is not None:
                        scheduler.remove(task.id)
                if auth_provider is not None:
                    auth_provider.revoke_user_sessions(user_id)
        return {
            "id": user_id,
            "deleted": removed,
            "sessions_deleted": sessions,
            "computers_stopped": hosts_stopped,
            "model_connections_deleted": keys,
        }

    return router
