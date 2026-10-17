"""Server side of tasks: applies what happened to a Conversation's task records (ADR 0025).

Every write comes from an event the engine saw (``deck_new`` returned, a file was saved, a Helper
started, a card was answered), never from the model's word. A Helper's events land on the
Conversation that started it.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from omnigent.context.labels import (
    ADHOC_HELPER_LABEL_KEY,
    SCHEDULED_FIRE_LABEL_KEY,
    SCHEDULED_HELPER_LABEL_KEY,
)
from omnigent.db.utils import now_epoch
from omnigent.entities import Conversation, MessageData
from omnigent.server.auth import RESERVED_USER_LOCAL
from omnigent.stores import ConversationStore
from omnigent.superchat.artifacts.links import is_person_message
from omnigent.superchat.tasks.record import (
    BUILDING,
    DONE,
    DROPPED,
    CardAnswer,
    Task,
    best_match,
    kind_for_name,
    parse_card_answer,
    record_answer,
)
from omnigent.superchat.tasks.store import SqlAlchemyTaskStore

_logger = logging.getLogger(__name__)

#: Labels the server stamps on a run no person started (a schedule, a Goal's cadence, a pass).
BACKGROUND_LABELS = (SCHEDULED_HELPER_LABEL_KEY, ADHOC_HELPER_LABEL_KEY, SCHEDULED_FIRE_LABEL_KEY)
#: Helpers nest one level (a worker's subworker); a deeper chain is not followed.
_MAX_HOPS = 4
#: Newest items read to find the person's latest message.
_LOOKBACK = 20
#: An active task nothing touched for this long was left behind: it is dropped when next read.
STALE_AFTER = 24 * 3600


@dataclass(frozen=True)
class Place:
    """Where a session's work lands: the Conversation, and what kind of run this is.

    :param conversation: The person-facing Conversation (the session itself, or a Helper's root).
    :param is_helper: The session is a Helper.
    :param background: A schedule or an ad-hoc pass started this work, not a person.
    """

    conversation: Conversation
    is_helper: bool
    background: bool


def _message_text(data: MessageData) -> str:
    return "\n\n".join(
        str(block.get("text"))
        for block in data.content
        if isinstance(block, dict)
        and block.get("type") == "input_text"
        and isinstance(block.get("text"), str)
    ).strip()


class TaskService:
    """Reads and writes a Conversation's tasks from the engine's own events."""

    def __init__(self, store: SqlAlchemyTaskStore, conversations: ConversationStore) -> None:
        self.store = store
        self.conversations = conversations
        #: ``Conversation id -> (item id, answer)``: the newest card answer, for the next turn.
        self._answers: dict[str, tuple[str, CardAnswer]] = {}

    # ------------------------------------------------------------------ where

    def place(self, session_id: str) -> Place | None:
        """The Conversation *session_id* works for, or ``None`` when it does not exist."""
        conv = self.conversations.get_conversation(session_id)
        if conv is None:
            return None
        background = any(key in conv.labels for key in BACKGROUND_LABELS)
        is_helper = conv.kind == "sub_agent"
        root = conv
        for _ in range(_MAX_HOPS):
            if root.kind != "sub_agent" or not root.parent_conversation_id:
                break
            parent = self.conversations.get_conversation(root.parent_conversation_id)
            if parent is None:
                break
            root = parent
            background = background or any(key in root.labels for key in BACKGROUND_LABELS)
        return Place(root, is_helper, background)

    def _owner(self, conversation_id: str) -> str:
        return self.conversations.get_session_owner(conversation_id) or RESERVED_USER_LOCAL

    def _latest_message(self, conversation_id: str) -> tuple[str | None, str]:
        """``(item id, text)`` of the person's latest message in the Conversation."""
        page = self.conversations.list_items(conversation_id, limit=_LOOKBACK, order="desc")
        for item in page.data:
            if is_person_message(item) and isinstance(item.data, MessageData):
                return item.id, _message_text(item.data)
        return None, ""

    # ------------------------------------------------------------------ reads

    def view(self, session_id: str) -> dict[str, Any] | None:
        """What a turn and ``deck_new`` read: the active tasks, the person's latest message and,
        when that message is a card answer, the answer."""
        place = self.place(session_id)
        if place is None:
            return None
        conversation_id = place.conversation.id
        item_id, message = self._latest_message(conversation_id)
        answered = self._answers.get(conversation_id)
        answer = answered[1] if answered and item_id and answered[0] == item_id else None
        tasks = self._active(conversation_id)
        return {
            "conversation_id": conversation_id,
            "is_helper": place.is_helper,
            "background": place.background,
            "message": message,
            "answer": answer.to_wire() if answer else None,
            "tasks": [t.to_wire() for t in tasks],
        }

    # ------------------------------------------------------------------ writes

    def _active(self, conversation_id: str) -> list[Task]:
        """The Conversation's active tasks, newest first; one left behind is dropped."""
        tasks = self.store.list(conversation_id, active_only=True)
        cutoff = now_epoch() - STALE_AFTER
        for task in tasks:
            if task.updated_at < cutoff:
                task.status = DROPPED
                self.store.save(task)
        return [t for t in tasks if t.status != DROPPED]

    def deck_built(self, session_id: str, event: Mapping[str, Any]) -> Task | None:
        """``deck_new`` returned a deck (or its layout menu): the deck task, building or open."""
        place = self.place(session_id)
        title = event.get("title")
        if place is None or not isinstance(title, str) or not title.strip():
            return None
        conversation_id = place.conversation.id
        name = str(event.get("file") or "")
        task = best_match(self._active(conversation_id), "deck", title, name)
        if task is None:
            task = self.store.create(self._owner(conversation_id), conversation_id, "deck", title)
        task.title = title.strip()[:256]
        for key in ("look", "look_id", "look_from", "file"):
            if isinstance(event.get(key), str) and event[key]:
                task.fields[key] = event[key]
        slides = event.get("slides")
        if isinstance(slides, int) and not isinstance(slides, bool) and slides > 0:
            task.fields["slides"] = slides
        if event.get("written") is True:
            task.status = BUILDING
        return self.store.save(task)

    def saved(self, session_id: str, event: Mapping[str, Any]) -> Task | None:
        """A file was saved with ``artifact_save``: the task it delivers is done."""
        place = self.place(session_id)
        name, group = event.get("name"), event.get("group_id")
        if place is None or not isinstance(name, str) or not isinstance(group, str):
            return None
        conversation_id = place.conversation.id
        title = str(event.get("title") or name)
        kind = kind_for_name(name)
        tasks = self.store.list(conversation_id)
        task = next((t for t in tasks if group in t.artifact_group_ids), None) or best_match(
            tasks, kind, title, name
        )
        if task is None:
            task = self.store.create(self._owner(conversation_id), conversation_id, kind, title)
            task.fields["file"] = name
        if group not in task.artifact_group_ids:
            task.artifact_group_ids.append(group)
        task.status = DONE
        return self.store.save(task)

    def helper_started(self, session_id: str, event: Mapping[str, Any]) -> Task | None:
        """A Helper was started: it works on the newest active task."""
        place = self.place(session_id)
        helper_id = event.get("helper_id")
        if place is None or not isinstance(helper_id, str) or not helper_id:
            return None
        tasks = self._active(place.conversation.id)
        if not tasks:
            return None
        task = tasks[0]
        if helper_id not in task.helper_ids:
            task.helper_ids.append(helper_id)
        return self.store.save(task)

    def card_answered(self, session_id: str, item_id: str, context: Mapping[str, Any]) -> None:
        """A message carried ``context.card_answer``: note it for the turn and on the task."""
        answer = parse_card_answer(context)
        if answer is None:
            return
        self._answers[session_id] = (item_id, answer)
        tasks = self._active(session_id)
        if not tasks:
            return
        task = tasks[0]
        record_answer(task, answer, item_id, _picked_look(answer))
        self.store.save(task)

    def conversation_deleted(self, session_id: str) -> None:
        """A deleted Conversation's tasks go with it."""
        self._answers.pop(session_id, None)
        self.store.delete_conversation(session_id)


def _picked_look(answer: CardAnswer) -> tuple[str, str] | None:
    """``(theme id, name)`` of the deck theme an answer picks (by option id or by naming it)."""
    from omnigent.superchat.decks import kit
    from omnigent.superchat.decks.look import named_themes

    templates = kit.templates()
    themes = {answer.option_id} if answer.option_id in templates else named_themes(answer.label)
    if len(themes) != 1:
        return None
    theme_id = themes.pop()
    return theme_id, templates[theme_id].name
