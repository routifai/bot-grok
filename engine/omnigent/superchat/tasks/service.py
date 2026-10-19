"""Server side of tasks: what a turn reads in front of the person's message, and the picks on
the cards that asked.

The Round record is the source (ADR 0029): the work still under way is the Conversation's
Rounds whose Helpers still run (:func:`~omnigent.superchat.rounds.read.open_rounds`), and a card
answer is kept on the message that carried it, the opener of its Round. Nothing creates or
settles a task record any more (no Helper's start or finish, no save, no turn): the ``tasks``
table is read, and only the plan a task already keeps is still written.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from omnigent.context.labels import BACKGROUND_LABELS
from omnigent.context.rollover import _MID_TURN_LIVE_STATUSES
from omnigent.db.utils import now_epoch
from omnigent.entities import Conversation, MessageData
from omnigent.stores import ConversationStore
from omnigent.superchat.artifacts.links import is_person_message
from omnigent.superchat.family.tree import STATUS_DONE, STATUS_IN_PROGRESS, sub_agent_status
from omnigent.superchat.rounds.read import open_rounds
from omnigent.superchat.rounds.record import round_of
from omnigent.superchat.rounds.store import SqlAlchemyRoundStore
from omnigent.superchat.tasks.record import (
    EVIDENCE_KINDS,
    STALE_AFTER,
    Task,
    comment_step,
    helper_ids,
    parse_card_answer,
    parse_step_comment,
    plan_views,
    plans_from_items,
    replay,
    tick,
)
from omnigent.superchat.tasks.store import SqlAlchemyTaskStore

_logger = logging.getLogger(__name__)

#: Helpers nest one level (a worker's subworker); a deeper chain is not followed.
_MAX_HOPS = 4
#: Newest items read to find the person's latest message.
_LOOKBACK = 20
#: The Helper whose turn ended well (its own ``turn_end``): finished, even while its live status
#: still says running.
_ENDED = "helper_turn_ended"
#: The plan the task keeps (ADR 0027), ticked by :func:`~omnigent.superchat.tasks.record.tick`.
_PLAN = "plan"
#: The person's latest comment on a plan step (``{item_id, step, text}``): the turn its message
#: opens reads it.
_COMMENT = "step_comment"


def _tick(task: Task, event: Mapping[str, Any]) -> bool:
    """Apply one evidence event to the task's plan, if it has one; whether it changed."""
    plan = task.fields.get(_PLAN)
    if not isinstance(plan, dict):
        return False
    ticked = tick(plan, event)
    if ticked is None or ticked == plan:
        return False
    task.fields[_PLAN] = ticked
    return True


@dataclass(frozen=True)
class Place:
    """Where a session's work lands: the Conversation, and what kind of run this is.

    :param conversation: The person-facing Conversation (the session itself, or a Helper's root).
    :param helpers: The Helper sessions from this one up to the Conversation (empty for the
        Conversation itself).
    :param background: A schedule or an ad-hoc pass started this work, not a person.
    :param round_id: The Round the session is in (a Helper's: the one it was started in), else
        ``None``.
    """

    conversation: Conversation
    helpers: tuple[str, ...]
    background: bool
    round_id: str | None = None

    @property
    def is_helper(self) -> bool:
        """The session is a Helper."""
        return bool(self.helpers)


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

    def __init__(
        self,
        store: SqlAlchemyTaskStore,
        conversations: ConversationStore,
        rounds: SqlAlchemyRoundStore,
    ) -> None:
        self.store = store
        self.conversations = conversations
        self.rounds = rounds

    # ------------------------------------------------------------------ where

    def place(self, session_id: str) -> Place | None:
        """The Conversation *session_id* works for, or ``None`` when it does not exist."""
        conv = self.conversations.get_conversation(session_id)
        if conv is None:
            return None
        background = any(key in conv.labels for key in BACKGROUND_LABELS)
        helpers: list[str] = []
        root = conv
        for _ in range(_MAX_HOPS):
            if root.kind != "sub_agent" or not root.parent_conversation_id:
                break
            parent = self.conversations.get_conversation(root.parent_conversation_id)
            if parent is None:
                break
            helpers.append(root.id)
            root = parent
            background = background or any(key in root.labels for key in BACKGROUND_LABELS)
        if conv.kind == "sub_agent" and not helpers:
            helpers.append(conv.id)
        return Place(root, tuple(helpers), background, round_of(conv.labels))

    def _latest_message(self, conversation_id: str) -> tuple[str | None, str, bool]:
        """``(item id, text, by a person)`` of the newest user-role message in the Conversation;
        the text is the person's latest words even when a runtime notice came after them."""
        page = self.conversations.list_items(conversation_id, limit=_LOOKBACK, order="desc")
        newest_by_person: bool | None = None
        for item in page.data:
            data = item.data
            if item.type != "message" or not isinstance(data, MessageData) or data.role != "user":
                continue
            person = is_person_message(item)
            if newest_by_person is None:
                newest_by_person = person
            if person:
                return item.id, _message_text(data), bool(newest_by_person)
        return None, "", False

    # ------------------------------------------------------------------ reads

    def view(self, session_id: str) -> dict[str, Any] | None:
        """What a turn and ``deck_new`` read: the person's latest message, whether a person
        opened this turn, the Round the session is in (``round_id``), the card answer that
        Round's message carried, and the Conversation's Rounds still working (``rounds``,
        :func:`~omnigent.superchat.rounds.read.open_rounds`). A read changes nothing.
        """
        place = self.place(session_id)
        if place is None:
            return None
        conversation_id = place.conversation.id
        item_id, message, by_person = self._latest_message(conversation_id)
        round_id = place.round_id
        # The pick is on the message that opened the Round; a pick sent as a steer is on its own.
        answer = next(
            (
                found
                for at in (round_id, item_id if by_person else None)
                if at and (found := self.store.answer(conversation_id, at)) is not None
            ),
            None,
        )
        comment = next(
            (
                {"step": c["step"], "text": c["text"]}
                for t in (self.store.list(conversation_id) if item_id and by_person else ())
                if isinstance(c := t.fields.get(_COMMENT), dict) and c.get("item_id") == item_id
            ),
            None,
        )
        return {
            "conversation_id": conversation_id,
            "is_helper": place.is_helper,
            "background": place.background,
            "message": message,
            "by_person": by_person and not place.is_helper,
            "round_id": round_id,
            "answer": answer.to_wire() if answer else None,
            "comment": comment,
            "rounds": open_rounds(self.rounds, self.conversations, conversation_id),
        }

    def plans(self, conversation_id: str) -> dict[str, dict[str, Any]]:
        """The plans the Conversation's tasks keep, by id (a newer task's plan wins)."""
        found: dict[str, dict[str, Any]] = {}
        for task in self.store.list(conversation_id):
            plan = task.fields.get(_PLAN)
            if isinstance(plan, dict) and isinstance(plan.get("id"), str):
                found.setdefault(plan["id"], plan)
        return found

    def plan_views(
        self, conversation_id: str, items: list[Mapping[str, Any]]
    ) -> dict[str, list[dict[str, Any]]]:
        """Every plan *items* show, projected with the engine's states: the one projection the
        transcript and the activity read (:func:`~omnigent.superchat.tasks.record.plan_views`).

        The plan a task keeps wins over the one the items show; the Conversation is running when
        its turn is mid-flight; each step's Helper is read now.
        """
        stored = self.plans(conversation_id)
        conversation = self.conversations.get_conversation(conversation_id)
        running = conversation is not None and (
            conversation.live_status in _MID_TURN_LIVE_STATUSES
        )
        shown = plans_from_items(items)
        helpers = self._helper_statuses(helper_ids([*stored.values(), *shown.values()]))
        return plan_views(stored, items, running=running, helpers=helpers)

    def _active(self, conversation_id: str) -> list[Task]:
        """The Conversation's active tasks, newest first, without those left behind, each with
        whether a Helper of it runs."""
        cutoff = now_epoch() - STALE_AFTER
        tasks = [
            t for t in self.store.list(conversation_id, active_only=True) if t.updated_at >= cutoff
        ]
        for task in tasks:
            statuses = self._task_helpers(task, task.helper_ids)
            task.helper_running = STATUS_IN_PROGRESS in statuses.values()
        return tasks

    def _helper_statuses(self, helper_ids: list[str]) -> dict[str, str]:
        if not helper_ids:
            return {}
        found = self.conversations.get_conversations(list(dict.fromkeys(helper_ids)))
        return {helper_id: sub_agent_status(conv) for helper_id, conv in found.items()}

    def _task_helpers(self, task: Task, helper_ids: list[str]) -> dict[str, str]:
        """The statuses of *helper_ids*, a Helper of *task* whose own turn ended reading done."""
        statuses = self._helper_statuses(helper_ids)
        ended = task.fields.get(_ENDED)
        if statuses.get(ended) == STATUS_IN_PROGRESS:
            statuses[ended] = STATUS_DONE
        return statuses

    # ------------------------------------------------------------------ writes

    def _sweep(self, conversation_id: str) -> None:
        """Drop the tasks left behind (:data:`STALE_AFTER`); called from the event paths."""
        self.store.drop_stale(conversation_id, now_epoch() - STALE_AFTER)

    def _start(self, place: Place) -> tuple[str, list[Task]]:
        conversation_id = place.conversation.id
        self._sweep(conversation_id)
        return conversation_id, self._active(conversation_id)

    @staticmethod
    def _helpers_task(place: Place, tasks: list[Task]) -> Task | None:
        """The task a Helper (or the Helper above it) was started for."""
        chain = set(place.helpers)
        return next((t for t in tasks if chain & set(t.helper_ids)), None)

    def plan_rendered(self, session_id: str, event: Mapping[str, Any]) -> Task | None:
        """A ``plan`` card was shown: the task the turn works on keeps it.

        Only a task a deliverable event made or found (``deck_new``, ``artifact_save``,
        ``start_helper``) keeps a plan: the runner sends the plan once its turn has one, so a
        plan with no deliverable makes no task. A new plan id starts a new plan, with the
        evidence the turn reported before it (``evidence``: the brief it read first); the same id
        again adds or rewords items and never changes their evidence.
        """
        place = self.place(session_id)
        plan_id, items = event.get("id"), event.get("items")
        if place is None or place.is_helper or not isinstance(plan_id, str) or not plan_id:
            return None
        if not isinstance(items, list):
            return None
        _conversation_id, active = self._start(place)
        task = next((t for t in active if t.id == event.get("task_id")), None) or next(
            (t for t in active if (t.fields.get(_PLAN) or {}).get("id") == plan_id), None
        )
        if task is None:
            return None
        render = {"kind": "plan", "id": plan_id, "items": items}
        plan = task.fields.get(_PLAN)
        if isinstance(plan, dict) and plan.get("id") == plan_id:
            task.fields[_PLAN] = tick(plan, render)
        else:
            early = [e for e in event.get("evidence") or () if isinstance(e, Mapping)]
            fresh = replay([*early, render])
            task.fields[_PLAN] = {**fresh, "kind": task.kind} if fresh else None
        return self.store.save(task)

    def evidence(self, session_id: str, event: Mapping[str, Any]) -> Task | None:
        """A tool result that ticks a plan step (``kind``: ``EVIDENCE_KINDS``), from the
        Conversation or one of its Helpers, on the task the work is for; saved only when it
        changed a step."""
        place = self.place(session_id)
        kind = event.get("kind")
        if place is None or kind not in EVIDENCE_KINDS:
            return None
        _conversation_id, active = self._start(place)
        planned = [t for t in active if isinstance(t.fields.get(_PLAN), dict)]
        task = (
            self._helpers_task(place, planned)
            if place.is_helper
            else next((t for t in planned if t.id == event.get("task_id")), None)
            or next(iter(planned), None)
        )
        if task is None or not _tick(task, {"kind": kind, "tool": event.get("tool")}):
            return None
        return self.store.save(task)

    def message_context(self, session_id: str, item_id: str, context: Mapping[str, Any]) -> None:
        """A person's message carried a ``context``: a card answer, a comment on a plan step."""
        self.card_answered(session_id, item_id, context)
        self.step_commented(session_id, item_id, context)

    def step_commented(self, session_id: str, item_id: str, context: Mapping[str, Any]) -> None:
        """A message carried ``context.step_comment``: keep it on the plan step it is about, and
        on the task for the turn that message opens (its prefix names it)."""
        comment = parse_step_comment(context)
        if comment is None:
            return
        for task in self.store.list(session_id):
            plan = task.fields.get(_PLAN)
            commented = comment_step(plan, comment) if isinstance(plan, dict) else None
            if commented is None:
                continue
            task.fields[_PLAN], step = commented
            task.fields[_COMMENT] = {"item_id": item_id, "step": step, "text": comment.text}
            self.store.save(task)
            return

    def card_answered(self, session_id: str, item_id: str, context: Mapping[str, Any]) -> None:
        """A message carried ``context.card_answer``: keep it on that message (the opener of the
        Round it starts), where the turn prefix and ``deck_new`` read it."""
        answer = parse_card_answer(context)
        if answer is not None:
            self.store.save_answer(session_id, item_id, answer)

    def conversation_deleted(self, session_id: str) -> None:
        """A deleted Conversation's tasks and card answers go with it."""
        self.store.delete_conversation(session_id)
