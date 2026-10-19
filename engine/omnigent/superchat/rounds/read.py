"""What reads a Round's record once a batch of its events is stored (ADR 0029).

* :class:`Announcer` folds a Round whose record grew and sends its summary as ``round.updated``
  on the Conversation's family stream, at most once per :data:`ANNOUNCE_EVERY` seconds per Round
  and only while a family stream is open.
* :func:`attach_round_files`, on when :data:`ROUND_FILES_ENV` is set, draws a transcript
  page's file cards from each Round's view instead of from the save calls on the page.
* :func:`shadow_diff`, on when :data:`SHADOW_ENV` is set, folds a Round after a turn of it ends
  and logs at INFO each way the fold disagrees with what the engine derives today from the
  stored items and Helper sessions: status, start time, files, Helpers, and the Round's file
  cards drawn with :data:`ROUND_FILES_ENV` off and on. Development only; nothing it finds
  reaches a person.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Mapping, Sequence
from typing import TYPE_CHECKING, Any

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
from omnigent.superchat.transcript.blocks import file_block, helper_session_ids, project_items

if TYPE_CHECKING:
    from omnigent.superchat.artifacts.store import SqlAlchemyArtifactStore

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
#: Set (``1``, ``true``) to draw file cards from each Round's record (:func:`attach_round_files`).
ROUND_FILES_ENV = "OMNIGENT_ROUND_FILES"
#: Messages searched back from a page for the Round its first items are in.
_OPENER_LOOKBACK = 50
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


def round_files_on() -> bool:
    """Whether file cards come from each Round's record (:data:`ROUND_FILES_ENV`)."""
    return env_var_is_truthy(ROUND_FILES_ENV, default=False)


def _is_card(block: Mapping[str, Any]) -> bool:
    """A file card the Assistant's work drew; a file the person delivered is not one."""
    return block.get("type") == "file" and block.get("by") != "user"


def cards(messages: Sequence[Mapping[str, Any]]) -> list[tuple[str, int | None]]:
    """The file cards of transcript *messages* in order, as ``(artifact_id, version)``."""
    return [
        (b["artifact_id"], b.get("version")) for m in messages for b in m["blocks"] if _is_card(b)
    ]


class _Views:
    """The fold of each Round asked for, read once; ``None`` for an id no Round has."""

    def __init__(self, store: SqlAlchemyRoundStore, conversation_id: str) -> None:
        self._store = store
        self._conversation_id = conversation_id
        self._views: dict[str, dict[str, Any] | None] = {}

    def __call__(self, round_id: str) -> dict[str, Any] | None:
        if round_id not in self._views:
            events = self._store.events(round_id, self._conversation_id)
            self._views[round_id] = fold(events, round_id) if events else None
        return self._views[round_id]


def _opener_before(
    conv_store: ConversationStore, conversation_id: str, item_id: str, views: _Views
) -> str | None:
    """The Round the items after *item_id* are in: the newest Round opened before them."""
    page = conv_store.list_items(
        conversation_id, limit=_OPENER_LOOKBACK, after=item_id, order="desc", type="message"
    )
    for item in page.data:
        data = item.data
        if data.role == "user" and not is_system_notice(data) and views(item.id) is not None:
            return item.id
    return None


def attach_round_files(
    store: SqlAlchemyRoundStore,
    conv_store: ConversationStore,
    conversation_id: str,
    messages: list[dict[str, Any]],
    *,
    first_item_id: str | None,
    newer_item_id: str | None,
    artifacts: SqlAlchemyArtifactStore | None = None,
) -> None:
    """Draw each recorded Round's file cards from its view, in place on transcript *messages*.

    The page is cut into Rounds at the person's messages that opened one; a steer stays in the
    Round it joined, and the messages before the page's first opener are in the Round opened
    before the page. A recorded Round's cards are its view's files in order, the Assistant's and
    its Helpers', as ``file`` blocks after the words of its last assistant message; the cards its
    save calls drew are dropped. A Round that goes on past the page (*newer_item_id*, the
    oldest item of the page after this one, is not an opener) draws its cards on the page that
    holds its end, so a page's size never moves a card. A Round with no record keeps the cards
    its calls drew.

    :param first_item_id: The oldest item of the page, ``None`` for an empty page.
    :param newer_item_id: The oldest item of the page after this one; ``None`` on the newest.
    :param artifacts: Where a card's title and size are read; without it a card has neither.
    """
    views = _Views(store, conversation_id)
    rounds: list[tuple[str | None, list[dict[str, Any]]]] = [(None, [])]
    for message in messages:
        if message["role"] == "user" and views(message["id"]) is not None:
            rounds.append((message["id"], []))
        rounds[-1][1].append(message)
    if rounds[0][1] and first_item_id is not None:
        opener = _opener_before(conv_store, conversation_id, first_item_id, views)
        rounds[0] = (opener, rounds[0][1])
    ends_later = newer_item_id is not None and views(newer_item_id) is None
    saved = (
        artifacts.for_rounds(conversation_id, [r for r, _ in rounds if r is not None])
        if artifacts is not None
        else {}
    )
    for index, (round_id, mine) in enumerate(rounds):
        view = views(round_id) if round_id is not None else None
        if view is None:
            continue
        for message in mine:
            message["blocks"] = [b for b in message["blocks"] if not _is_card(b)]
        replies = [m for m in mine if m["role"] == "assistant"]
        closing = next((m for m in reversed(replies) if m["blocks"]), None)
        closing = closing or (replies[-1] if replies else None)
        if closing is None or (index == len(rounds) - 1 and ends_later):
            continue
        rows = {a.id: a for a in saved.get(round_id, [])}
        for f in view["files"]:
            row = rows.get(f["artifact_id"])
            block = file_block(
                {
                    "type": "artifact",
                    "id": f["artifact_id"],
                    "name": f["name"],
                    "kind": f["kind"],
                    "version": f["version"],
                    "title": row.title if row else None,
                    "size": row.size if row else None,
                }
            )
            if block:
                closing["blocks"].append(block)
    messages[:] = [m for m in messages if m["blocks"]]


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


def _round_cards(
    store: SqlAlchemyRoundStore,
    conv_store: ConversationStore,
    conversation_id: str,
    items: list[Any],
) -> dict[str, list[tuple[str, int | None]]]:
    """The Round's file cards drawn from its *items*, with :data:`ROUND_FILES_ENV` off and on."""
    messages = project_items([item.to_api_dict() for item in items])
    off = cards(messages)
    attach_round_files(
        store,
        conv_store,
        conversation_id,
        messages,
        first_item_id=items[0].id,
        newer_item_id=None,
    )
    return {"off": off, "on": cards(messages)}


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

    :returns: The fields that disagree, e.g. ``["files"]``; ``cards`` when the Round's file
        cards differ with :data:`ROUND_FILES_ENV` off (logged as ``today``) and on (``fold``).
    """
    events = store.events(round_id, conversation_id)
    today = derive_today(conv_store, conversation_id, round_id)
    if not events or today is None:
        return []
    drawn = _round_cards(
        store, conv_store, conversation_id, _round_items(conv_store, conversation_id, round_id)
    )
    view = fold(events, round_id)
    folded = {
        "status": view["status"],
        "started_at": view["started_at"],
        "files": {f["name"] for f in view["files"]},
        "helpers": set(view["helpers"]),
        "cards": drawn["on"],
    }
    today["cards"] = drawn["off"]
    differ = [
        key
        for key in ("status", "started_at", "files", "helpers", "cards")
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
