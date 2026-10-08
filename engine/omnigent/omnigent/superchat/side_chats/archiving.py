"""Auto-archive of Side Chats (forks included): one setting per person, one sweeper.

``GET /v1/me/archiving`` returns ``{"side_chat_auto_archive_days": 1 | 7 | 30 | null,
"default_days": int}``. The first is the person's *effective* setting (``null`` means never),
``default_days`` is what applies to someone who never chose (the deployment default,
``OMNIGENT_SIDE_CHAT_ARCHIVE_AFTER_SECONDS``, 30 days unless configured, rounded to days).

``PUT /v1/me/archiving`` takes ``{"side_chat_auto_archive_days": 1 | 7 | 30 | null | "default"}``:
``null`` is an explicit never, ``"default"`` forgets the choice so the deployment default applies
again. Anything else is refused with ``invalid_input``. It returns the same body as ``GET``.

Stored in the ``preferences`` table under the person's Muse key (``user`` + ``tenant``, see
:func:`omnigent.superchat.muse.muse_key`): no row means unset, JSON ``null`` means never.

:class:`SideChatArchiveSweeper` is the only archiver. Each tick it walks every Super Chat (Muse),
finds its Side Chats through the side-chat parent label (so grant-less and legacy chats count),
and archives those not archived, with no turn in flight, whose last activity is older than the
person's effective age. The activity signal is ``Conversation.updated_at``: the store bumps it
whenever an item is appended, so it is the time of the newest item (a rename moves it too).
Archiving goes through the manual archive's steps (flag and label, family ``chats.changed``,
read-state prune, deferred runner stop). The Super Chat and Helpers are never touched.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from collections.abc import Awaitable, Callable
from contextlib import suppress
from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select

from omnigent.context.labels import SUBAGENT_LABEL_KEY
from omnigent.context.rollover import _MID_TURN_LIVE_STATUSES
from omnigent.db.db_models import SqlPreference, current_workspace_id, workspace_scope
from omnigent.db.utils import (
    get_or_create_engine,
    make_named_managed_session_maker,
    run_write_transaction,
)
from omnigent.errors import ErrorCode, OmnigentError
from omnigent.server.auth import RESERVED_USER_LOCAL, AuthProvider
from omnigent.server.routes._auth_helpers import require_user
from omnigent.stores.conversation_store import SIDE_CHAT_LABEL_KEY, ConversationStore

_logger = logging.getLogger(__name__)

PREFERENCE_KEY = "side_chat_auto_archive_days"
ALLOWED_DAYS = (1, 7, 30)
#: The stored/wire state "use the deployment default" (no row stored).
DEFAULT = "default"
_SECONDS_PER_DAY = 24 * 60 * 60

#: Kept from the sweeper this one replaced.
SWEEP_INTERVAL_SECONDS_ENV = "OMNIGENT_SIDE_CHAT_ARCHIVE_SWEEP_INTERVAL_SECONDS"
DEFAULT_SWEEP_INTERVAL_SECONDS = 3600.0
_PAGE_SIZE = 200
_MAX_SCANNED_PER_PERSON = 5_000

#: ``"default"`` (unset), ``None`` (never) or a number of days.
Setting = int | str | None


def resolve_sweep_interval_seconds() -> float:
    """Hourly by default; the env override is for tests and local runs."""
    raw = os.environ.get(SWEEP_INTERVAL_SECONDS_ENV)
    try:
        value = float(raw) if raw is not None else DEFAULT_SWEEP_INTERVAL_SECONDS
    except ValueError:
        return DEFAULT_SWEEP_INTERVAL_SECONDS
    return value if value > 0 else DEFAULT_SWEEP_INTERVAL_SECONDS


def validate_setting(value: object) -> Setting:
    """``None``, ``"default"`` or one of :data:`ALLOWED_DAYS`; else ``invalid_input``."""
    if value is None or (value == DEFAULT and isinstance(value, str)):
        return value
    if isinstance(value, bool) or not isinstance(value, int) or value not in ALLOWED_DAYS:
        raise OmnigentError(
            'side_chat_auto_archive_days must be null, 1, 7, 30 or "default"',
            code=ErrorCode.INVALID_INPUT,
        )
    return value


def default_days() -> int:
    """The deployment default in whole days (at least 1), for display."""
    from omnigent.superchat.side_chats.chats import resolve_archive_after_seconds

    return max(1, round(resolve_archive_after_seconds() / _SECONDS_PER_DAY))


def age_seconds(setting: Setting) -> int | None:
    """Idle seconds before archiving for *setting*; ``None`` means never."""
    from omnigent.superchat.side_chats.chats import resolve_archive_after_seconds

    if setting == DEFAULT:
        return resolve_archive_after_seconds()
    return None if setting is None else int(setting) * _SECONDS_PER_DAY


class ArchivePrefsStore:
    """The auto-archive setting per person, in the generic ``preferences`` table."""

    def __init__(self, storage_location: str) -> None:
        self._engine = get_or_create_engine(storage_location)
        self._session = make_named_managed_session_maker(
            self._engine, query_name_prefix="omnigent.side_chat_archive_prefs"
        )
        self._session_immediate = make_named_managed_session_maker(
            self._engine, query_name_prefix="omnigent.side_chat_archive_prefs", immediate=True
        )

    def get(self, key: str) -> Setting:
        """The person's setting; ``"default"`` when never chosen."""
        with self._session("select_side_chat_archive_days") as session:
            row = session.get(SqlPreference, (current_workspace_id(), key, PREFERENCE_KEY))
            return _decode(row.value) if row is not None else DEFAULT

    def set(self, key: str, setting: Setting) -> None:
        """Store *setting*; ``"default"`` removes the row."""

        def write(session: Any) -> None:
            pk = (current_workspace_id(), key, PREFERENCE_KEY)
            row = session.get(SqlPreference, pk)
            if setting == DEFAULT:
                if row is not None:
                    session.delete(row)
                return
            if row is None:
                session.add(
                    SqlPreference(user_id=key, key=PREFERENCE_KEY, value=json.dumps(setting))
                )
            else:
                row.value = json.dumps(setting)

        run_write_transaction(self._session_immediate, "upsert_side_chat_archive_days", write)

    def list_stored(self) -> dict[tuple[int, str], Setting]:
        """Every stored choice, as ``{(workspace_id, muse_key): setting}``, in one query."""
        with self._session("list_side_chat_archive_days") as session:
            rows = session.execute(
                select(
                    SqlPreference.workspace_id, SqlPreference.user_id, SqlPreference.value
                ).where(SqlPreference.key == PREFERENCE_KEY)
            ).all()
        return {(int(ws), key): _decode(value) for ws, key, value in rows}


def _decode(raw: str | None) -> Setting:
    """A stored value; anything unreadable falls back to the default rather than to never."""
    try:
        value = json.loads(raw) if raw else DEFAULT
    except ValueError:
        return DEFAULT
    if value is None or (isinstance(value, int) and value in ALLOWED_DAYS):
        return value
    return DEFAULT


class ArchivingBody(BaseModel):
    """Body of ``PUT /v1/me/archiving``; the value is validated by :func:`validate_setting`."""

    model_config = ConfigDict(extra="forbid")

    side_chat_auto_archive_days: Any = None


def _response(setting: Setting) -> dict[str, Any]:
    return {
        PREFERENCE_KEY: default_days() if setting == DEFAULT else setting,
        "default_days": default_days(),
    }


def register_archiving_routes(
    prefs: ArchivePrefsStore, *, auth_provider: AuthProvider | None = None
) -> APIRouter:
    """``GET`` / ``PUT /me/archiving`` (mount with ``prefix="/v1"``); see the module docstring."""
    from omnigent.superchat.muse import muse_key

    router = APIRouter()

    def _key(request: Request) -> str:
        user_id = require_user(request, auth_provider)
        tenant = auth_provider.get_tenant(request) if auth_provider is not None else None
        return muse_key(user_id or RESERVED_USER_LOCAL, tenant)

    @router.get("/me/archiving")
    async def get_archiving(request: Request) -> dict[str, Any]:
        """The caller's effective side chat auto-archive setting (``null`` = never)."""
        return _response(await asyncio.to_thread(prefs.get, _key(request)))

    @router.put("/me/archiving")
    async def put_archiving(request: Request, body: ArchivingBody) -> dict[str, Any]:
        """Set it: 1, 7, 30, ``null`` (never) or ``"default"`` (forget the choice)."""
        key = _key(request)
        if PREFERENCE_KEY not in body.model_fields_set:
            raise OmnigentError(f"{PREFERENCE_KEY} is required", code=ErrorCode.INVALID_INPUT)
        setting = validate_setting(body.side_chat_auto_archive_days)
        await asyncio.to_thread(prefs.set, key, setting)
        return _response(setting)

    return router


def list_muses(conv_store: ConversationStore) -> list[tuple[int, str, str]]:
    """``(workspace_id, super_chat_id, muse_key)`` for every Super Chat, across workspaces."""
    from omnigent.superchat.muse import MUSE_KEY_LABEL_KEY, MUSE_LABEL_KEY

    holders = conv_store.find_label_holders_all_workspaces(MUSE_LABEL_KEY, "true")
    out: list[tuple[int, str, str]] = []
    by_workspace: dict[int, list[str]] = {}
    for workspace_id, conv_id in holders:
        by_workspace.setdefault(workspace_id, []).append(conv_id)
    for workspace_id, ids in by_workspace.items():
        with workspace_scope(workspace_id):
            for start in range(0, len(ids), _PAGE_SIZE):
                rows = conv_store.get_conversations(ids[start : start + _PAGE_SIZE])
                for conv in rows.values():
                    key = conv.labels.get(MUSE_KEY_LABEL_KEY)
                    # Side chats and forks made before their copies dropped the Muse labels.
                    if key and SIDE_CHAT_LABEL_KEY not in conv.labels:
                        out.append((workspace_id, conv.id, key))
    return out


def due_side_chats(
    conv_store: ConversationStore, muse_id: str, seconds: int, now: int
) -> list[str]:
    """Ids of the Super Chat's Side Chats (forks too) idle for *seconds* and safe to archive.

    Found by the side-chat parent label (and the older fork-source label), oldest activity first,
    stopping at the first chat fresher than the threshold. No owner check: legacy chats count.
    """
    due: dict[str, None] = {}
    for link in ("side_chat_parent_id", "fork_source_id"):
        after: str | None = None
        scanned = 0
        while scanned < _MAX_SCANNED_PER_PERSON:
            page = conv_store.list_conversations(
                limit=_PAGE_SIZE,
                after=after,
                kind="default",
                order="asc",
                sort_by="updated_at",
                include_archived=False,
                **{link: muse_id},
            )
            fresh = False
            for chat in page.data:
                scanned += 1
                if now - chat.updated_at < seconds:
                    fresh = True
                    break
                if (
                    SIDE_CHAT_LABEL_KEY in chat.labels
                    and chat.kind != "sub_agent"
                    and SUBAGENT_LABEL_KEY not in chat.labels
                    and not chat.archived
                    and chat.live_status not in _MID_TURN_LIVE_STATUSES
                ):
                    due[chat.id] = None
            if fresh or not page.has_more or not page.data:
                break
            after = page.data[-1].id
    return list(due)


ArchiveFn = Callable[[str], Awaitable[None]]


async def sweep_side_chats(
    prefs: ArchivePrefsStore | None,
    conv_store: ConversationStore,
    archive: ArchiveFn,
    *,
    now: int | None = None,
) -> int:
    """Archive every person's idle Side Chats by their effective age; returns how many.

    People without a stored choice get the deployment default; an explicit never is skipped.
    Idempotent.
    """
    reference = int(time.time()) if now is None else now
    stored = await asyncio.to_thread(prefs.list_stored) if prefs is not None else {}
    archived = 0
    for workspace_id, muse_id, key in await asyncio.to_thread(list_muses, conv_store):
        seconds = age_seconds(stored.get((workspace_id, key), DEFAULT))
        if seconds is None:
            continue
        with workspace_scope(workspace_id):
            ids = await asyncio.to_thread(due_side_chats, conv_store, muse_id, seconds, reference)
            for session_id in ids:
                await archive(session_id)
                archived += 1
    return archived


def manual_archive_steps(app: Any, conv_store: ConversationStore) -> ArchiveFn:
    """The manual archive (``PATCH archived: true``) as a function of the session id."""

    async def archive(session_id: str) -> None:
        from omnigent.server.routes._sessions.helpers import _prune_session_read_state
        from omnigent.server.routes._sessions.orchestration import _spawn_archive_stop
        from omnigent.superchat.family.signals import notify_session_changed

        updated = await asyncio.to_thread(
            conv_store.update_conversation, session_id, archived=True
        )
        if updated is None:
            return
        await notify_session_changed(conv_store, session_id)
        _prune_session_read_state(session_id)
        _spawn_archive_stop(
            session_id,
            conv_store,
            getattr(app.state, "side_chat_runner_router", None),
            getattr(app.state, "host_registry", None),
        )

    return archive


class SideChatArchiveSweeper:
    """The background loop running :func:`sweep_side_chats` (hourly by default)."""

    def __init__(
        self,
        prefs: ArchivePrefsStore | None,
        conv_store: ConversationStore,
        archive: ArchiveFn,
        *,
        sweep_interval_s: float | None = None,
    ) -> None:
        self._prefs = prefs
        self._conv_store = conv_store
        self._archive = archive
        self._interval = (
            sweep_interval_s if sweep_interval_s is not None else resolve_sweep_interval_seconds()
        )
        self._task: asyncio.Task[None] | None = None

    async def sweep_once(self, now: int | None = None) -> int:
        """One pass; returns the number of Side Chats archived."""
        return await sweep_side_chats(self._prefs, self._conv_store, self._archive, now=now)

    async def start(self) -> None:
        """Start the loop."""
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run(), name="side-chat-archive-sweeper")

    async def shutdown(self) -> None:
        """Stop the loop."""
        task, self._task = self._task, None
        if task is None:
            return
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task

    async def _run(self) -> None:
        while True:
            try:
                count = await self.sweep_once()
                if count:
                    _logger.info("Auto-archived %s side chat(s)", count)
            except asyncio.CancelledError:
                raise
            except Exception:
                _logger.exception("Side chat auto-archive sweep failed; retrying later")
            await asyncio.sleep(self._interval)
