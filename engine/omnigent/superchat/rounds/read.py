"""What reads a Round's record once a batch of its events is stored (ADR 0029).

* :class:`Announcer` folds a Round whose record grew and sends its summary as ``round.updated``
  on the Conversation's family stream, at most once per :data:`ANNOUNCE_EVERY` seconds per Round
  and only while a family stream is open.
* :func:`shadow_diff`, on when :data:`SHADOW_ENV` is set, folds a Round after a turn of it ends
  and logs at INFO each way the fold disagrees with what the engine derives today from the
  stored items and Helper sessions: status, start time, files and Helpers. Development only;
  nothing it finds reaches a person.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Sequence
from typing import Any

from omnigent.entities.conversation import is_system_notice
from omnigent.server.auth import env_var_is_truthy
from omnigent.stores.conversation_store import ConversationStore
from omnigent.superchat.activity.derive import _turn_status
from omnigent.superchat.family import signals
from omnigent.superchat.family.tree import (
    STATUS_CANCELLED,
    STATUS_IN_PROGRESS,
    sub_agent_status,
)
from omnigent.superchat.rounds.fold import TURN_ENDED, fold, summary
from omnigent.superchat.rounds.store import RoundEvent, SqlAlchemyRoundStore
from omnigent.superchat.transcript.blocks import helper_session_ids, project_items

_logger = logging.getLogger(__name__)

#: Seconds between two ``round.updated`` of one Round.
ANNOUNCE_EVERY = 0.25
#: Set (``1``, ``true``) to log where the fold and today's derivation disagree.
SHADOW_ENV = "OMNIGENT_ROUND_SHADOW"
#: Seconds after a turn ends before the shadow diff reads, so its items are stored.
SHADOW_DELAY = 2.0
#: Items of a Round the shadow diff reads at most.
_SHADOW_ITEMS = 500
#: Seconds two start times may differ by and still agree.
_START_SLACK = 2.0
#: Today's statuses (an Activity's, a Helper's) as the fold names them.
_OLD_STATUS = {STATUS_IN_PROGRESS: "running", STATUS_CANCELLED: "stopped"}


class Announcer:
    """Sends ``round.updated`` for each Round whose record grew, coalesced per Round."""

    def __init__(self, store: SqlAlchemyRoundStore, every: float = ANNOUNCE_EVERY) -> None:
        self._store = store
        self._every = every
        self._dirty: dict[str, str] = {}  # round -> conversation, written since last sent
        self._tasks: dict[str, asyncio.Task[None]] = {}

    def written(self, batch: Sequence[RoundEvent]) -> None:
        """Note the Rounds *batch* wrote to; call on the loop."""
        for event in batch:
            if not signals.listening(event.conversation_id):
                continue
            self._dirty[event.round_id] = event.conversation_id
            if event.round_id not in self._tasks:
                self._tasks[event.round_id] = asyncio.get_running_loop().create_task(
                    self._send(event.round_id)
                )

    async def _send(self, round_id: str) -> None:
        try:
            while (conversation_id := self._dirty.pop(round_id, None)) is not None:
                events = await asyncio.to_thread(self._store.events, round_id)
                if events:
                    view = fold(events, round_id)
                    signals.notify_round_updated(conversation_id, round_id, summary(view))
                await asyncio.sleep(self._every)
        except Exception:
            _logger.warning("round %s not announced", round_id, exc_info=True)
        finally:
            self._tasks.pop(round_id, None)


def shadow_on() -> bool:
    """Whether the shadow diff runs (:data:`SHADOW_ENV`)."""
    return env_var_is_truthy(SHADOW_ENV, default=False)


def _round_items(conv_store: ConversationStore, conversation_id: str, round_id: str) -> list[Any]:
    """The Conversation's items from the Round's message up to the person's next message."""
    opener = conv_store.get_item(conversation_id, round_id)
    if opener is None:
        return []
    after = conv_store.list_items(conversation_id, limit=_SHADOW_ITEMS, after=round_id).data
    items = [opener]
    for item in after:
        data = item.data
        if item.type == "message" and data.role == "user" and not is_system_notice(data):
            if item.response_id != opener.response_id:  # a steer stays in its turn
                break
        items.append(item)
    return items


def _file_names(items: list[Any]) -> set[str]:
    names: set[str] = set()
    for message in project_items([item.to_api_dict() for item in items]):
        names |= {b["name"] for b in message["blocks"] if b.get("type") == "file"}
    return names


def derive_today(
    conv_store: ConversationStore, conversation_id: str, round_id: str
) -> dict[str, Any] | None:
    """The Round as the engine derives it today: from the Conversation's stored items (the
    Activity's turn status, the transcript's file and Helper blocks) and the Helper sessions.

    :returns: ``status`` (fold names), ``started_at``, ``files`` and ``helpers`` (sets), or
        ``None`` when the Round's message is not stored.
    """
    conversation = conv_store.get_conversation(conversation_id)
    items = _round_items(conv_store, conversation_id, round_id)
    if conversation is None or not items:
        return None
    latest = conv_store.list_items(conversation_id, limit=1, order="desc").data
    last_group = [i for i in items if i.response_id == items[-1].response_id]
    status = _turn_status(
        conversation,
        last_group,
        is_latest_group=bool(latest) and latest[0].response_id == items[-1].response_id,
    )
    helper_ids = helper_session_ids([item.to_api_dict() for item in items])
    helpers = conv_store.get_conversations(helper_ids) if helper_ids else {}
    if any(sub_agent_status(h) == STATUS_IN_PROGRESS for h in helpers.values()):
        status = STATUS_IN_PROGRESS
    files = _file_names(items)
    for helper_id in helpers:
        files |= _file_names(conv_store.list_items(helper_id, limit=_SHADOW_ITEMS).data)
    return {
        "status": _OLD_STATUS.get(status, "done"),
        "started_at": float(items[0].created_at),
        "files": files,
        "helpers": set(helpers),
    }


def shadow_diff(
    store: SqlAlchemyRoundStore,
    conv_store: ConversationStore,
    conversation_id: str,
    round_id: str,
) -> list[str]:
    """Fold the Round, derive it today's way, and log each field they disagree on.

    :returns: The fields that disagree, e.g. ``["files"]``.
    """
    events = store.events(round_id, conversation_id)
    today = derive_today(conv_store, conversation_id, round_id)
    if not events or today is None:
        return []
    view = fold(events, round_id)
    folded = {
        "status": view["status"],
        "started_at": view["started_at"],
        "files": {f["name"] for f in view["files"]},
        "helpers": set(view["helpers"]),
    }
    differ = [
        key
        for key in ("status", "started_at", "files", "helpers")
        if (
            abs((folded[key] or 0) - today[key]) > _START_SLACK
            if key == "started_at"
            else folded[key] != today[key]
        )
    ]
    for key in differ:
        fold_value, today_value = (
            (sorted(v) if isinstance(v, set) else v) for v in (folded[key], today[key])
        )
        _logger.info(
            "round %s shadow %s: fold=%r today=%r", round_id, key, fold_value, today_value
        )
    return differ


class Shadow:
    """Runs :func:`shadow_diff` :data:`SHADOW_DELAY` seconds after a turn of a Round ends."""

    def __init__(self, store: SqlAlchemyRoundStore, conv_store: ConversationStore) -> None:
        self._store = store
        self._conv_store = conv_store
        self._tasks: dict[str, asyncio.Task[None]] = {}

    def written(self, batch: Sequence[RoundEvent]) -> None:
        """Schedule a diff for each Round in *batch* a turn of which ended."""
        for event in batch:
            if event.kind == TURN_ENDED and event.round_id not in self._tasks:
                self._tasks[event.round_id] = asyncio.get_running_loop().create_task(
                    self._diff(event.conversation_id, event.round_id)
                )

    async def _diff(self, conversation_id: str, round_id: str) -> None:
        try:
            await asyncio.sleep(SHADOW_DELAY)
            await asyncio.to_thread(
                shadow_diff, self._store, self._conv_store, conversation_id, round_id
            )
        except Exception:
            _logger.warning("round %s shadow diff failed", round_id, exc_info=True)
        finally:
            self._tasks.pop(round_id, None)
