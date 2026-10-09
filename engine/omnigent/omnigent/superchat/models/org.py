"""Organization admin state for models: the model overlay and account suspension.

Both are small JSON rows in the generic ``preferences`` table, so there is no new table:

* the **overlay** (``model_org_overlay``, owned by :data:`WORKSPACE_OWNER`, the identity no person
  can hold) narrows what the connection binding offers: per harness an optional allowlist and an
  optional default model. :func:`apply_overlay` merges it into a harness binding while a session's
  inference snapshot is prepared (``catalog = binding allowlist ∩ org allow``, org default replaces
  the binding default, and the person's own default still wins over both);
* a **suspension** (``account_suspended``, one row under the suspended user's id) stops that
  person's usage. The model proxy and the session create/turn routes read it through
  :func:`refuse_if_suspended`. Deleting the account deletes its preference rows, flag included.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import cachetools

from omnigent.db.db_models import SqlPreference, current_workspace_id
from omnigent.db.utils import (
    get_or_create_engine,
    make_named_managed_session_maker,
    now_epoch,
    run_write_transaction,
)
from omnigent.db.workspace_cache import WorkspaceScopedCache
from omnigent.errors import ErrorCode, OmnigentError
from omnigent.server.auth import RESERVED_USER_WORKSPACE

OVERLAY_KEY = "model_org_overlay"
SUSPENDED_KEY = "account_suspended"
WORKSPACE_OWNER = RESERVED_USER_WORKSPACE
SUSPENDED_MESSAGE = "Your account is suspended. Contact an admin to continue."
_CACHE_TTL_SECONDS = 5

# {harness: {"allow": [model ids] | None, "default": model id | None}}
Overlay = dict[str, dict[str, Any]]


def parse_overlay(raw: Any) -> Overlay:
    """Keep only well-formed per-harness entries of a stored overlay (never raises)."""
    harnesses = raw.get("harnesses") if isinstance(raw, dict) else None
    result: Overlay = {}
    for harness, entry in (harnesses if isinstance(harnesses, dict) else {}).items():
        if not isinstance(harness, str) or not isinstance(entry, dict):
            continue
        allow = entry.get("allow")
        default = entry.get("default")
        allow = (
            list(dict.fromkeys(allow))
            if isinstance(allow, list) and all(isinstance(m, str) and m for m in allow)
            else None
        )
        default = default if isinstance(default, str) and default else None
        if allow is not None or default is not None:
            result[harness] = {"allow": allow, "default": default}
    return result


def apply_overlay(binding: dict[str, Any], entry: dict[str, Any] | None) -> None:
    """Merge one harness's overlay *entry* into its saved *binding* dict, in place.

    The allowlist is intersected with the binding's own (kept in the binding's order); an
    unrestricted binding takes the overlay's list as is. The org default replaces the binding's
    default when the resulting list still contains it.
    """
    if not entry:
        return
    allow = entry.get("allow")
    if allow is not None:
        own = binding.get("model_allowlist")
        binding["model_allowlist"] = list(allow) if own is None else [m for m in own if m in allow]
    default = entry.get("default")
    if default is not None:
        kept = binding.get("model_allowlist")
        if kept is None or default in kept:
            binding["default_model"] = default
    kept = binding.get("model_allowlist")
    if binding.get("default_model") is not None and kept is not None:
        if binding["default_model"] not in kept:
            binding.pop("default_model")


class ModelOrgOverlayStore:
    """The organization's model overlay: one JSON row under :data:`WORKSPACE_OWNER`."""

    def __init__(self, storage_location: str) -> None:
        engine = get_or_create_engine(storage_location)
        prefix = "omnigent.model_org_overlay"
        self._session = make_named_managed_session_maker(engine, query_name_prefix=prefix)
        self._session_immediate = make_named_managed_session_maker(
            engine, query_name_prefix=prefix, immediate=True
        )

    def get(self) -> Overlay:
        """The overlay; empty when never set or unreadable."""
        with self._session("select_model_org_overlay") as session:
            row = session.get(
                SqlPreference, (current_workspace_id(), WORKSPACE_OWNER, OVERLAY_KEY)
            )
            raw = row.value if row is not None else None
        try:
            return parse_overlay(json.loads(raw)) if raw else {}
        except ValueError:
            return {}

    def set(self, overlay: Overlay) -> None:
        """Replace the overlay; an empty one removes the row."""

        def write(session: Any) -> None:
            pk = (current_workspace_id(), WORKSPACE_OWNER, OVERLAY_KEY)
            row = session.get(SqlPreference, pk)
            value = json.dumps({"harnesses": overlay})
            if not overlay:
                if row is not None:
                    session.delete(row)
            elif row is None:
                session.add(SqlPreference(user_id=WORKSPACE_OWNER, key=OVERLAY_KEY, value=value))
            else:
                row.value = value

        run_write_transaction(self._session_immediate, "upsert_model_org_overlay", write)


class SuspensionStore:
    """Who is suspended: a flag row per user in ``preferences`` with a short read cache."""

    def __init__(self, storage_location: str) -> None:
        engine = get_or_create_engine(storage_location)
        prefix = "omnigent.account_suspension"
        self._session = make_named_managed_session_maker(engine, query_name_prefix=prefix)
        self._session_immediate = make_named_managed_session_maker(
            engine, query_name_prefix=prefix, immediate=True
        )
        # The proxy checks every model call: a TTL keeps that to a dict lookup. Changes evict on
        # this replica at once; other replicas see them within the TTL.
        self._cache: WorkspaceScopedCache[str, bool] = WorkspaceScopedCache(
            lambda: cachetools.TTLCache(maxsize=4096, ttl=_CACHE_TTL_SECONDS)
        )

    def is_suspended(self, user_id: str) -> bool:
        cached = self._cache.get(user_id)
        if cached is not None:
            return cached
        with self._session("select_account_suspended") as session:
            found = (
                session.get(SqlPreference, (current_workspace_id(), user_id, SUSPENDED_KEY))
                is not None
            )
        self._cache[user_id] = found
        return found

    def suspend(self, user_id: str, by: str | None) -> None:
        """Flag *user_id* suspended (idempotent; keeps the first timestamp)."""

        def write(session: Any) -> None:
            pk = (current_workspace_id(), user_id, SUSPENDED_KEY)
            if session.get(SqlPreference, pk) is None:
                value = json.dumps({"at": now_epoch(), "by": by})
                session.add(SqlPreference(user_id=user_id, key=SUSPENDED_KEY, value=value))

        run_write_transaction(self._session_immediate, "suspend_account", write)
        self._cache.pop(user_id, None)

    def resume(self, user_id: str) -> None:
        """Lift the suspension (idempotent)."""

        def write(session: Any) -> None:
            row = session.get(SqlPreference, (current_workspace_id(), user_id, SUSPENDED_KEY))
            if row is not None:
                session.delete(row)

        run_write_transaction(self._session_immediate, "resume_account", write)
        self._cache.pop(user_id, None)

    def suspended_since(self) -> dict[str, int | None]:
        """Every suspended user with the epoch they were suspended at (uncached)."""
        from sqlalchemy import select

        with self._session("select_suspended_accounts") as session:
            rows = session.execute(
                select(SqlPreference.user_id, SqlPreference.value)
                .where(SqlPreference.workspace_id == current_workspace_id())
                .where(SqlPreference.key == SUSPENDED_KEY)
            ).all()
        found: dict[str, int | None] = {}
        for user_id, raw in rows:
            try:
                at = json.loads(raw).get("at")
            except (ValueError, AttributeError):
                at = None
            found[user_id] = at if isinstance(at, int) else None
        return found


_suspensions: SuspensionStore | None = None


def bind_suspensions(store: SuspensionStore | None) -> None:
    """Bind the server's suspensions so routes and the proxy can find them (``None`` unbinds)."""
    global _suspensions
    _suspensions = store


def get_suspensions() -> SuspensionStore | None:
    """The bound suspensions, or ``None`` when the server has none (nobody can be suspended)."""
    return _suspensions


def suspended_error() -> OmnigentError:
    """The refusal a suspended person gets, as an engine error."""
    return OmnigentError(SUSPENDED_MESSAGE, code=ErrorCode.ACCOUNT_SUSPENDED)


async def refuse_if_suspended(user_id: str | None) -> None:
    """Raise ``ACCOUNT_SUSPENDED`` when *user_id* is suspended; a no-op otherwise.

    :raises OmnigentError: ``ACCOUNT_SUSPENDED`` (HTTP 403).
    """
    store = _suspensions
    if store is None or not user_id:
        return
    if await asyncio.to_thread(store.is_suspended, user_id):
        raise suspended_error()
