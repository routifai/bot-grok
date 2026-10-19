"""Server side of tasks: applies what happened to a Conversation's task records (ADR 0025).

Every write comes from an event the engine saw (``deck_new`` returned, a file was saved, a Helper
started, a card was answered, a turn ended), never from the model's word. A Helper's events land
on the Conversation that started it, on the task the Helper was started for. The lifecycle is in
:mod:`omnigent.superchat.tasks.record`.
"""

from __future__ import annotations

import json
import logging
import threading
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from omnigent.context.labels import BACKGROUND_LABELS
from omnigent.context.rollover import _MID_TURN_LIVE_STATUSES
from omnigent.db.utils import now_epoch
from omnigent.entities import Conversation, FunctionCallData, FunctionCallOutputData, MessageData
from omnigent.server.auth import RESERVED_USER_LOCAL
from omnigent.stores import ConversationStore
from omnigent.superchat.artifacts.links import is_person_message
from omnigent.superchat.family.tree import STATUS_DONE, STATUS_IN_PROGRESS, sub_agent_status
from omnigent.superchat.tasks.decisions import record_decision
from omnigent.superchat.tasks.record import (
    ACTIVE,
    BUILDING,
    DONE,
    EVIDENCE_KINDS,
    OPEN,
    STALE_AFTER,
    Task,
    best_match,
    comment_step,
    decision_line,
    helper_ids,
    kind_for_brief,
    kind_for_name,
    parse_card_answer,
    parse_step_comment,
    plan_views,
    plans_from_items,
    record_answer,
    replay,
    tick,
)
from omnigent.superchat.tasks.store import SqlAlchemyTaskStore

_logger = logging.getLogger(__name__)

#: Helpers nest one level (a worker's subworker); a deeper chain is not followed.
_MAX_HOPS = 4
#: Newest items read to find the person's latest message.
_LOOKBACK = 20
#: Newest card results searched for the card an answer names.
_CARD_LOOKBACK = 50
#: A Conversation turn saved this task; its ``turn_end`` closes it (popped there).
_SAVED = "saved_this_turn"
#: The last Helper whose finish was read onto the task, so it is read once.
_SETTLED = "helper_settled"
#: The Helper whose turn ended well (its own ``turn_end``): finished, even while its live status
#: still says running.
_ENDED = "helper_turn_ended"
#: Seconds a Helper's end waits to look again at a Conversation turn that was still running.
IDLE_RECHECK = 3.0
#: The plan the task keeps (ADR 0027), ticked by :func:`~omnigent.superchat.tasks.record.tick`.
_PLAN = "plan"
#: Done tasks a read lists (``done``), newest first: what the context brief reads.
RECENT_DONE = 3
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
    """

    conversation: Conversation
    helpers: tuple[str, ...]
    background: bool

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

    def __init__(self, store: SqlAlchemyTaskStore, conversations: ConversationStore) -> None:
        self.store = store
        self.conversations = conversations

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
        return Place(root, tuple(helpers), background)

    def _owner(self, conversation_id: str) -> str:
        return self.conversations.get_session_owner(conversation_id) or RESERVED_USER_LOCAL

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
        """What a turn and ``deck_new`` read: the active tasks, the person's latest message,
        whether a person opened this turn and, when that message answers a card, the answer.

        A read changes nothing: a Helper that finished since the last ``turn_start`` already
        reads as it will be settled (done when it finished, open again when it failed), and
        ``turn_start`` settles it. ``done`` lists the last :data:`RECENT_DONE` done tasks.
        """
        place = self.place(session_id)
        if place is None:
            return None
        conversation_id = place.conversation.id
        item_id, message, by_person = self._latest_message(conversation_id)
        answer = self.store.answer(conversation_id, item_id) if item_id and by_person else None
        tasks = self._active(conversation_id)
        settle = bool(self._settle_helpers(tasks))
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
            "answer": answer.to_wire() if answer else None,
            "settle": settle,
            "comment": comment,
            "tasks": [t.to_wire() for t in tasks if t.status in ACTIVE],
            "done": [t.to_wire() for t in self.recent_done(conversation_id, RECENT_DONE)],
        }

    def recent_done(self, conversation_id: str, n: int) -> list[Task]:
        """The Conversation's last *n* done tasks, newest first (each with its decision line)."""
        return [t for t in self.store.list(conversation_id) if t.status == DONE][:n]

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

    def _settle_helpers(self, tasks: list[Task]) -> list[Task]:
        """In memory: a task whose newest Helper finished since it was last settled is done when
        it finished well, open again otherwise; each finished Helper settles the plan step it
        was doing. Returns the tasks that changed (the caller saves them, or not for a read)."""
        changed: list[Task] = []
        for task in tasks:
            moved = self._settle_plan(task)
            last = task.helper_ids[-1] if task.helper_ids else None
            if last is not None and not task.helper_running and task.fields.get(_SETTLED) != last:
                finished = self._task_helpers(task, [last]).get(last)
                if finished is not None:
                    task.fields[_SETTLED] = last
                    if finished == STATUS_DONE:
                        task.status = DONE
                    else:
                        task.status = OPEN
                    moved = True
            if moved:
                changed.append(task)
        return changed

    def _close(self, task: Task) -> None:
        """The task is done: its decision line (ADR 0027) is composed once, kept on the record
        for the brief and put in the working list (the runner journals it from the reply)."""
        task.status = DONE
        task.fields["decision"] = decision_line(task)
        record_decision(self.conversations, task)
        _logger.info(
            "task %s closed: %s",
            task.id,
            task.fields["decision"],
            extra={"session_id": task.conversation_id},
        )

    def _settle_plan(self, task: Task) -> bool:
        """Tick the plan items whose Helper finished (``helper_done``); whether any changed."""
        plan = task.fields.get(_PLAN)
        if not isinstance(plan, dict):
            return False
        doing = [
            str(item["helper_id"])
            for item in plan.get("items", ())
            if item.get("evidence") == "doing" and item.get("helper_id")
        ]
        statuses = self._task_helpers(task, doing)
        changed = False
        for helper_id in doing:
            status = statuses.get(helper_id)
            if status is None or status == STATUS_IN_PROGRESS:
                continue
            ok = status == STATUS_DONE
            event = {"kind": "helper_done", "helper_id": helper_id, "ok": ok}
            changed = _tick(task, event) or changed
        return changed

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

    def _new(self, conversation_id: str, kind: str, title: str) -> Task:
        return self.store.create(self._owner(conversation_id), conversation_id, kind, title)

    def deck_built(self, session_id: str, event: Mapping[str, Any]) -> Task | None:
        """``deck_new`` returned a deck (or its layout menu): the deck task, building.

        The deck's file finds its task among all of the Conversation's, so an event that arrives
        after the file was saved updates the done task instead of opening a second one, and
        never moves it back to building.
        """
        place = self.place(session_id)
        title = event.get("title")
        if place is None or not isinstance(title, str) or not title.strip():
            return None
        conversation_id, active = self._start(place)
        name = str(event.get("file") or "")
        task = (
            next(
                (
                    t
                    for t in self.store.list(conversation_id)
                    if name and t.kind == "deck" and t.fields.get("file") == name
                ),
                None,
            )
            or self._helpers_task(place, active)
            or best_match(active, "deck", title, name)
            or self._new(conversation_id, "deck", title)
        )
        if not place.is_helper:
            task.title = title.strip()[:256]
        for key in ("look", "look_id", "look_from", "file"):
            if isinstance(event.get(key), str) and event[key]:
                task.fields[key] = event[key]
        slides = event.get("slides")
        if isinstance(slides, int) and not isinstance(slides, bool) and slides > 0:
            task.fields["slides"] = slides
        if event.get("written") is True:
            _tick(task, {"kind": "built", "deliverable": "deck"})
        if task.status != DONE:
            task.status = BUILDING
        return self.store.save(task)

    def saved(self, session_id: str, event: Mapping[str, Any]) -> Task | None:
        """A file was saved with ``artifact_save``.

        In the Conversation it delivers its task (or, with no open task, opens one), closed when
        the turn ends. A Helper's save is a draft of the task it was started for.
        """
        place = self.place(session_id)
        name, group = event.get("name"), event.get("group_id")
        if place is None or not isinstance(name, str) or not isinstance(group, str):
            return None
        conversation_id, active = self._start(place)
        title = str(event.get("title") or name)
        kind = kind_for_name(name)
        task = next(
            (t for t in self.store.list(conversation_id) if group in t.artifact_group_ids), None
        )
        if place.is_helper:
            task = (
                task or self._helpers_task(place, active) or best_match(active, kind, title, name)
            )
            if task is None:
                return None
        else:
            task = (
                task
                or best_match(active, kind, title, name)
                or next((t for t in active if t.kind == kind), None)
            )
            if task is None:
                task = self._new(conversation_id, kind, title)
                task.fields["file"] = name
            task.fields[_SAVED] = True
            if task.status != DONE:
                task.status = BUILDING
        if group not in task.artifact_group_ids:
            task.artifact_group_ids.append(group)
        artifact_id = event.get("artifact_id")
        _tick(task, {"kind": "saved", "name": name, "title": title, "artifact_id": artifact_id})
        return self.store.save(task)

    def helper_started(self, session_id: str, event: Mapping[str, Any]) -> Task | None:
        """A Helper was started: it works on the task it was started for.

        That is the starting Helper's own task, else the newest active task of the kind its
        brief names (any kind when the brief names none), else a new task.
        """
        place = self.place(session_id)
        helper_id = event.get("helper_id")
        if place is None or not isinstance(helper_id, str) or not helper_id:
            return None
        conversation_id, active = self._start(place)
        brief = str(event.get("title") or "")
        kind = kind_for_brief(brief)
        task = (
            self._helpers_task(place, active)
            or next((t for t in active if t.kind == kind), None)
            or (active[0] if active and kind == "file" else None)
            or self._new(conversation_id, kind, brief or kind)
        )
        if helper_id not in task.helper_ids:
            task.helper_ids.append(helper_id)
            _tick(task, {"kind": "helper_started", "helper_id": helper_id})
        if task.status != DONE:
            task.status = BUILDING
        task.helper_running = True
        return self.store.save(task)

    def turn_started(self, session_id: str, _event: Mapping[str, Any]) -> list[Task]:
        """A Conversation turn started: a Helper that finished since settles its task and plan
        step (done when it finished well, open again otherwise). Answers with the tasks it
        closed."""
        place = self.place(session_id)
        if place is None or place.is_helper:
            return []
        return self._settle(place.conversation.id)

    def _settle(self, conversation_id: str) -> list[Task]:
        """Save what finished Helpers did to their tasks; the tasks it closed."""
        closed: list[Task] = []
        for task in self._settle_helpers(self._active(conversation_id)):
            if task.status == DONE:
                self._close(task)
                closed.append(task)
            self.store.save(task)
        return closed

    def turn_ended(self, session_id: str, _event: Mapping[str, Any]) -> list[Task]:
        """A turn ended. Answers with every task it closed (their decision lines are in the
        working list; the runner journals them).

        A Conversation's turn settles what finished Helpers did (as ``turn_start``); then a task
        it saved is done, unless a Helper of it still runs, and a task it was building and no
        Helper runs for is open again. A Helper's turn is its finish: the newest Helper of a
        task reads done from now on, and settles the task at once when no Conversation turn
        runs; one that runs settles it at its own end, and the task is looked at once more
        after :data:`IDLE_RECHECK` in case that turn had already ended.
        """
        place = self.place(session_id)
        if place is None:
            return []
        conversation_id = place.conversation.id
        if place.is_helper:
            return self._helper_ended(place)
        closed = self._settle(conversation_id)
        for task in self._active(conversation_id):
            saved = task.fields.pop(_SAVED, False)
            if task.helper_running:
                if saved:
                    self.store.save(task)
                continue
            if saved:
                self._close(task)
                closed.append(task)
                self.store.save(task)
            elif task.status != OPEN:
                task.status = OPEN
                self.store.save(task)
        return closed

    def _helper_ended(self, place: Place) -> list[Task]:
        helper_id = place.helpers[0]
        task = self._helpers_task(place, self._active(place.conversation.id))
        if task is None or task.helper_ids[-1] != helper_id:
            return []
        task.fields[_ENDED] = helper_id
        self.store.save(task)
        conversation_id = place.conversation.id
        if place.conversation.live_status not in _MID_TURN_LIVE_STATUSES:
            return self._settle(conversation_id)
        # The running turn settles it at its end; look once more in case it already ended.
        again = threading.Timer(IDLE_RECHECK, self._settle_if_idle, (conversation_id,))
        again.daemon = True
        again.start()
        return []

    def _settle_if_idle(self, conversation_id: str) -> None:
        """Settle finished Helpers when no Conversation turn runs. Never raises."""
        try:
            conversation = self.conversations.get_conversation(conversation_id)
            if conversation is not None and (
                conversation.live_status not in _MID_TURN_LIVE_STATUSES
            ):
                self._settle(conversation_id)
        except Exception:  # the next turn settles it
            _logger.warning("tasks of %s not settled", conversation_id, exc_info=True)

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
        """A message carried ``context.card_answer``: keep it on the message, and on the task
        its card asked for."""
        answer = parse_card_answer(context)
        if answer is None:
            return
        task_id = self._card_task(session_id, answer.card_id)
        self.store.save_answer(session_id, item_id, answer, task_id)
        task = self.store.get(task_id) if task_id else None
        if task is None or task.conversation_id != session_id or task.status not in ACTIVE:
            return
        record_answer(task, answer, item_id)
        _tick(task, {"kind": "answered"})
        self.store.save(task)

    def _card_task(self, conversation_id: str, card_id: str) -> str | None:
        """The task id the card *card_id* recorded, else ``None``.

        The web sends the engine's own card id (the transcript's ``card_id``, the card's ``id``);
        an older client sends ``<call item id>:<block>``, matched by the call's result.
        """
        outputs = self.conversations.list_items(
            conversation_id, limit=_CARD_LOOKBACK, order="desc", type="function_call_output"
        ).data
        call_id = self._call_id(conversation_id, card_id.split(":", 1)[0])
        for item in outputs:
            data = item.data
            if not isinstance(data, FunctionCallOutputData):
                continue
            try:
                card = json.loads(data.output)
            except ValueError:
                continue
            if not isinstance(card, dict) or card.get("type") != "card":
                continue
            if card.get("id") == card_id or (call_id is not None and data.call_id == call_id):
                task_id = card.get("task_id")
                return task_id if isinstance(task_id, str) and task_id else None
        return None

    def _call_id(self, conversation_id: str, item_id: str) -> str | None:
        """The ``call_id`` of the function call stored as *item_id*, else ``None``."""
        try:
            call = self.conversations.get_item(conversation_id, item_id)
        except Exception:  # noqa: BLE001 - a malformed id from the client is no call
            return None
        if call is None or not isinstance(call.data, FunctionCallData):
            return None
        return call.data.call_id

    def conversation_deleted(self, session_id: str) -> None:
        """A deleted Conversation's tasks and card answers go with it."""
        self.store.delete_conversation(session_id)
