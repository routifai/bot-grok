"""What a turn reads in front of the person's message, and the one rule for when a turn ends
well.

Pure: no store, no HTTP. The runner writes :func:`prefix_lines` in front of the person's
message: the pick on a card, then one :func:`round_line` per Round still working (ADR 0029,
read from the Round record), and judges each turn with :func:`ends_well` (the scenario evals
import the same function). :class:`Task` is the ADR 0025 record the ``tasks`` table still holds;
nothing creates or settles one any more.

A task also keeps the plan of the turn that worked on it (ADR 0027), ticked only by evidence:
:func:`evidence_for` reads a tool result as an event, :func:`tick` applies it, :func:`project`
reads each item's ``state``; the runner, the service, the transcript, the activity and the
scenario evals use these same functions.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any

from omnigent.entities.conversation import is_system_notice_text
from omnigent.superchat.artifact_kinds import is_deck_name
from omnigent.superchat.titles import truncate

KINDS = ("deck", "page", "document", "sheet", "file")
OPEN, BUILDING, DONE, DROPPED = "open", "building", "done", "dropped"
STATUSES = (OPEN, BUILDING, DONE, DROPPED)
#: Statuses a turn still works on: they go in front of the person's message.
ACTIVE = (OPEN, BUILDING)
#: An active task nothing touched for this long (seconds) was left behind: reads skip it, and the
#: next event on its Conversation drops it.
STALE_AFTER = 24 * 3600
#: At most this many task lines go in front of a message.
MAX_LINES = 5
LINE_OPEN = "Open task: "
PICKED_LINE = "They picked {label}. Continue the task; do not plan it again."
#: A comment the person left on one plan step, in front of the message it travelled with.
STEP_LINE = 'About the step "{step}": {comment}'
#: Comments kept on one step.
_MAX_COMMENTS = 10
#: Longest ask a line quotes.
_ASK_CHARS = 80
_KIND_BY_SUFFIX = {
    ".html": "page",
    ".htm": "page",
    ".md": "document",
    ".docx": "document",
    ".pdf": "document",
    ".txt": "document",
    ".csv": "sheet",
    ".xlsx": "sheet",
}


@dataclass
class Task:
    """One deliverable in progress, as ADR 0025 recorded it (see ``SqlTask``).

    :param helper_running: A Helper started for it is still running; read from the Helpers when
        the task is read, never stored.
    """

    id: str
    owner: str
    conversation_id: str
    kind: str
    title: str
    fields: dict[str, Any] = field(default_factory=dict)
    status: str = OPEN
    artifact_group_ids: list[str] = field(default_factory=list)
    helper_ids: list[str] = field(default_factory=list)
    created_at: int = 0
    updated_at: int = 0
    helper_running: bool = False

    def to_wire(self) -> dict[str, Any]:
        """The task as the routes return it."""
        return {
            "id": self.id,
            "conversation_id": self.conversation_id,
            "kind": self.kind,
            "title": self.title,
            "fields": self.fields,
            "status": self.status,
            "artifact_group_ids": self.artifact_group_ids,
            "helper_ids": self.helper_ids,
            "helper_running": self.helper_running,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


@dataclass(frozen=True)
class CardAnswer:
    """The person's pick on an ``ask`` card, sent beside the message (``context.card_answer``)."""

    card_id: str
    option_id: str
    label: str

    def to_wire(self) -> dict[str, str]:
        """``{card_id, option_id, label}``."""
        return {"card_id": self.card_id, "option_id": self.option_id, "label": self.label}


_MAX_ANSWER_CHARS = 200


def parse_card_answer(context: Mapping[str, Any] | None) -> CardAnswer | None:
    """The card answer in a message event's ``context``, or ``None`` for any other shape."""
    if not isinstance(context, Mapping):
        return None
    raw = context.get("card_answer")
    if not isinstance(raw, Mapping):
        return None
    values = [raw.get(key) for key in ("card_id", "option_id", "label")]
    if not all(isinstance(v, str) and v.strip() for v in values):
        return None
    card_id, option_id, label = (" ".join(str(v).split())[:_MAX_ANSWER_CHARS] for v in values)
    return CardAnswer(card_id, option_id, label)


@dataclass(frozen=True)
class StepComment:
    """The person's comment on one plan step, sent beside a message (``context.step_comment``).

    :param card_id: The plan card's id (the plan's id).
    :param step_index: The step's position in the plan, from 0.
    :param text: The comment.
    """

    card_id: str
    step_index: int
    text: str


def parse_step_comment(context: Mapping[str, Any] | None) -> StepComment | None:
    """The step comment in a message event's ``context``, or ``None`` for any other shape."""
    raw = context.get("step_comment") if isinstance(context, Mapping) else None
    if not isinstance(raw, Mapping):
        return None
    card_id, index, text = raw.get("card_id"), raw.get("step_index"), raw.get("text")
    if not isinstance(card_id, str) or not card_id.strip() or not isinstance(text, str):
        return None
    if not isinstance(index, int) or isinstance(index, bool) or index < 0:
        return None
    line = " ".join(text.split())[:_MAX_ANSWER_CHARS]
    return StepComment(card_id.strip(), index, line) if line else None


def comment_step(
    plan: Mapping[str, Any], comment: StepComment
) -> tuple[dict[str, Any], str] | None:
    """The plan with *comment* kept on its step, and the step's text; ``None`` when the plan has
    no such step."""
    if plan.get("id") != comment.card_id or comment.step_index >= len(plan.get("items") or ()):
        return None
    items = [dict(item) for item in plan["items"]]
    step = items[comment.step_index]
    step["comments"] = [*step.get("comments", ()), comment.text][-_MAX_COMMENTS:]
    return {**plan, "items": items}, str(step.get("text") or "")


def kind_for_name(name: str) -> str:
    """The task kind a saved file of this name delivers."""
    if is_deck_name(name):
        return "deck"
    low = name.lower()
    return next((k for suffix, k in _KIND_BY_SUFFIX.items() if low.endswith(suffix)), "file")


def round_line(row: Mapping[str, Any]) -> str:
    """One line naming a Round still working (``rounds.read.open_rounds``) and what comes next,
    e.g. ``Open task: "make a deck on Uruguay" · helper "Uruguay deck" · next: wait for the
    helper``."""
    ask = truncate(str(row.get("ask") or ""), _ASK_CHARS)
    parts = [f'{LINE_OPEN}"{ask}"' if ask else LINE_OPEN.rstrip(": ")]
    helpers = [h for h in row.get("helpers") or () if isinstance(h, Mapping)]
    parts += [f'helper "{h["title"]}"' if h.get("title") else "helper" for h in helpers]
    parts.append("next: wait for the helper")
    return " · ".join(parts)


def prefix_lines(
    rounds: Iterable[Mapping[str, Any]],
    answer: CardAnswer | None,
    comment: Mapping[str, str] | None = None,
) -> list[str]:
    """What goes in front of the person's message: the pick first, then the comment on a plan
    step (``{"step", "text"}``), then the Rounds still working (at most :data:`MAX_LINES`
    lines)."""
    lines = [PICKED_LINE.format(label=answer.label)] if answer is not None else []
    if comment and comment.get("text"):
        lines.append(STEP_LINE.format(step=comment.get("step") or "", comment=comment["text"]))
    lines += [round_line(r) for r in rounds]
    return lines[:MAX_LINES]


@dataclass
class Turn:
    """What one Conversation turn was and did, as far as its tasks go.

    :param by_person: A person's message opened it (not a runtime notice, nor a Helper's
        progress, flag or completion wake).
    :param task_id: The open task at its start, or ``None``.
    :param helper_running: A Helper of that task was running at its start: the message steers or
        waits on work already under way.
    :param saved: A file was saved (``artifact_save``).
    :param asked: A question card was shown (``ask_clarification``).
    :param helper_started: A Helper was started (``start_helper``).
    :param refused: The step limit refused a call.
    """

    by_person: bool
    task_id: str | None = None
    helper_running: bool = False
    saved: bool = False
    asked: bool = False
    helper_started: bool = False
    refused: bool = False


def ends_well(turn: Turn) -> bool:
    """Whether a turn ends as ADR 0025 says; ``False`` is a **stall**. The one definition.

    Only a turn a person opened is judged, and never one answered while a Helper of its task
    runs. It stalls when the step limit refused it and it started no Helper, or when it began on
    an open task and ended without a save, a question card or a started Helper.
    """
    if not turn.by_person or turn.helper_running:
        return True
    if turn.refused and not turn.helper_started:
        return False
    return turn.task_id is None or turn.saved or turn.asked or turn.helper_started


def is_stall(turn: Turn) -> bool:
    """A turn that does not end well (:func:`ends_well`)."""
    return not ends_well(turn)


# ---------------------------------------------------------------------------------------- plan
# ADR 0027: "A step is done only with evidence." The model writes the plan (a ``plan`` card); the
# engine ticks its items from what it saw happen.

#: What an item's done criterion names: the evidence that ticks it.
BRIEF, HELPER_DONE, CHECK_RAN, SAVED, READ, ANSWERED = (
    "brief",
    "helper_done",
    "check_ran",
    "saved",
    "read",
    "answered",
)
DONE_WHEN = (BRIEF, HELPER_DONE, CHECK_RAN, SAVED, READ, ANSWERED)
OWNERS = ("me", "helper")
#: Evidence an item holds (stored).
TODO, DOING, FAILED = "todo", "doing", "failed"
#: What a projected item reads (``state``): the evidence, or what its absence means.
CLAIMED, NOT_CHECKED, STOPPED = "claimed", "not_checked", "stopped"
STATES = (TODO, DOING, DONE, CLAIMED, FAILED, NOT_CHECKED, STOPPED)
#: Deliverable kind -> the tool that checks it. Only these kinds need a check step: a plan for
#: any other kind ends on a ``read`` or ``saved`` step and never reads "Not checked".
CHECK_TOOLS: Mapping[str, str] = {"deck": "deck_check"}
#: Tools whose result reads what the person has (``read``); ``files_*`` count too.
READ_TOOLS = frozenset({"recall", "recall_get"})
#: The evidence the runner reports as an ``evidence`` event; the rest rides on the task events
#: (``deck_new``, ``artifact_save``, ``start_helper``) or the card answer.
EVIDENCE_KINDS = frozenset({BRIEF, READ, "check"})
#: A Helper status that means it is still working (``family.tree.STATUS_IN_PROGRESS``).
_HELPER_WORKING = "in_progress"
_HELPER_OK = "done"
#: Items a plan holds, as the card schema allows.
_MAX_ITEMS = 50
#: The model's fields a projected item carries beside ``state`` (never its ``status``).
_ITEM_FIELDS = ("text", "active", "owner", "done_when")
#: What else a projected item carries when it has it: the person's comments on it.
_KEPT_FIELDS = (*_ITEM_FIELDS, "comments")


def _plan_item(raw: Mapping[str, Any]) -> dict[str, Any] | None:
    text = raw.get("text")
    if not isinstance(text, str) or not text.strip():
        return None
    item: dict[str, Any] = {"text": text.strip()}
    if isinstance(raw.get("active"), str) and raw["active"].strip():
        item["active"] = raw["active"].strip()
    if raw.get("owner") in OWNERS:
        item["owner"] = raw["owner"]
    if raw.get("done_when") in DONE_WHEN:
        item["done_when"] = raw["done_when"]
    # The model's word, kept for creation only: a "done" without evidence reads ``claimed``.
    item["claimed"] = raw.get("status") == DONE
    item["evidence"] = TODO
    return item


def _first(plan: dict[str, Any], states: tuple[str, ...], **match: Any) -> dict[str, Any] | None:
    return next(
        (
            item
            for item in plan["items"]
            if item["evidence"] in states and all(item.get(k) == v for k, v in match.items())
        ),
        None,
    )


def _helper_step(plan: dict[str, Any]) -> dict[str, Any] | None:
    """The step a started Helper takes: the first Helper-owned todo step that is not a check
    (a check is ticked by a check tool only), else the first ``helper_done`` one."""
    return next(
        (
            item
            for item in plan["items"]
            if item["evidence"] == TODO
            and "helper_id" not in item
            and item.get("owner") == "helper"
            and item.get("done_when") != CHECK_RAN
        ),
        None,
    ) or _first(plan, (TODO,), done_when=HELPER_DONE)


def tick(plan: Mapping[str, Any] | None, event: Mapping[str, Any]) -> dict[str, Any] | None:
    """The plan after one evidence *event*; a new plan on a ``plan`` event with another id.

    Events (``kind`` plus fields): ``plan`` (``id``, ``items``: the card's items; the same id
    again may add or reword items, never change their evidence), ``brief`` (the brief step,
    else a ``read`` one), ``read``, ``built`` (a deliverable was written; ``deliverable``: its
    kind), ``saved`` (``name``, ``artifact_id``, ``title``: also lists the output), ``check``
    (counts only after a build or a save), ``helper_started`` (``helper_id``: see
    :func:`_helper_step`), ``helper_done`` (``helper_id``, ``ok``: its step is done when its
    criterion is the Helper finishing, failed when it failed) and ``answered``. Any other event,
    or any event before a plan, changes nothing.
    """
    kind = event.get("kind")
    if kind == "plan":
        return _render(plan, event)
    if plan is None:
        return None
    out: dict[str, Any] = {
        **plan,
        "items": [dict(item) for item in plan["items"]],
        "outputs": list(plan.get("outputs") or ()),
    }
    item: dict[str, Any] | None = None
    if kind == BRIEF:
        item = _first(out, (TODO,), done_when=BRIEF) or _first(out, (TODO,), done_when=READ)
    elif kind == READ:
        item = _first(out, (TODO,), done_when=READ)
    elif kind == "built":
        out["built"] = True
        if isinstance(event.get("deliverable"), str) and not out.get("kind"):
            out["kind"] = event["deliverable"]
    elif kind == SAVED:
        out["built"] = True
        name = event.get("name")
        if isinstance(name, str) and name:
            out["kind"] = out.get("kind") or kind_for_name(name)
            if all(o.get("name") != name for o in out["outputs"]):
                output = {"name": name}
                for key in ("artifact_id", "title"):
                    if isinstance(event.get(key), str) and event[key]:
                        output[key] = event[key]
                out["outputs"].append(output)
        item = _first(out, (TODO, DOING), done_when=SAVED)
    elif kind == "check" and out.get("built"):
        item = _first(out, (TODO, DOING), done_when=CHECK_RAN)
    elif kind == ANSWERED:
        item = _first(out, (TODO,), done_when=ANSWERED)
    elif kind == "helper_started" and isinstance(event.get("helper_id"), str):
        found = _helper_step(out)
        if found is not None:
            found["evidence"] = DOING
            found["helper_id"] = event["helper_id"]
    elif kind == "helper_done":
        found = _first(out, (DOING,), helper_id=event.get("helper_id"))
        if found is not None and event.get("ok") is not True:
            found["evidence"] = FAILED
        elif found is not None and found.get("done_when") in (None, HELPER_DONE):
            found["evidence"] = DONE
    if item is not None:
        item["evidence"] = DONE
    return out


def _render(plan: Mapping[str, Any] | None, event: Mapping[str, Any]) -> dict[str, Any] | None:
    plan_id = event.get("id")
    raw = event.get("items")
    if not isinstance(plan_id, str) or not plan_id or not isinstance(raw, list):
        return dict(plan) if plan is not None else None
    items = [i for i in (_plan_item(r) for r in raw if isinstance(r, Mapping)) if i]
    if plan is None or plan.get("id") != plan_id:
        return {"id": plan_id, "items": items[:_MAX_ITEMS], "outputs": [], "built": False}
    kept = [dict(item) for item in plan["items"]]
    for index, new in enumerate(items[:_MAX_ITEMS]):
        if index >= len(kept):
            kept.append(new)
            continue
        old = kept[index]
        for key in _ITEM_FIELDS:
            if key in new:
                old[key] = new[key]
    return {**plan, "items": kept}


def replay(events: Iterable[Mapping[str, Any]]) -> dict[str, Any] | None:
    """The plan *events* make, in order; evidence before the first plan (the brief the turn
    reads first) is applied once the plan is rendered."""
    plan: dict[str, Any] | None = None
    waiting: list[Mapping[str, Any]] = []
    for event in events:
        if plan is None and event.get("kind") != "plan":
            waiting.append(event)
            continue
        fresh = event.get("kind") == "plan" and (plan is None or plan["id"] != event.get("id"))
        plan = tick(plan, event)
        if fresh and plan is not None:
            for early in waiting:
                plan = tick(plan, early)
            waiting = []
    return plan


def tool_result(output: str | None) -> dict[str, Any] | None:
    """A tool's output as a result: its JSON object, ``{}`` for any other text; ``None`` when it
    failed (a JSON object with an ``error`` field) or there is none."""
    if not output or not output.strip():
        return None
    try:
        data = json.loads(output)
    except ValueError:
        return {}
    if not isinstance(data, dict):
        return {}
    return None if "error" in data else data


def evidence_for(tool: str, output: str | None, *, call_id: str = "") -> dict[str, Any] | None:
    """The plan event one tool *output* is (``None`` for a failure or no evidence).

    :param tool: The tool name, bare or behind a harness prefix.
    :param output: Its output text (:func:`tool_result` reads it).
    :param call_id: The call's id: the id of a plan card that has none.
    """
    result = tool_result(output)
    if result is None:
        return None
    base = tool.rsplit("__", 1)[-1]
    if base == "render_card":
        if result.get("type") != "card" or result.get("card") != "plan":
            return None
        data = result.get("data")
        plan_id = str(result.get("id") or call_id)
        if not plan_id:
            return None
        return {
            "kind": "plan",
            "id": plan_id,
            "title": result.get("title"),
            "items": data.get("items") if isinstance(data, Mapping) else None,
        }
    if base == "context_brief":
        return {"kind": BRIEF}
    if base in READ_TOOLS or base.startswith("files_"):
        return {"kind": READ}
    if base in CHECK_TOOLS.values():
        return {"kind": "check", "tool": base}
    if base == "deck_new" and isinstance(result.get("deck"), Mapping):
        return {"kind": "built", "deliverable": "deck"}
    if base == "artifact_save" and result.get("type") == "artifact":
        return {
            "kind": SAVED,
            "name": result.get("name"),
            "artifact_id": result.get("id"),
            "title": result.get("title"),
        }
    if base == "start_helper" and result.get("started") is True:
        return {"kind": "helper_started", "helper_id": result.get("helper_id")}
    if base == "ask_clarification":
        return {"kind": "asked"}
    return None


def needs_check(plan: Mapping[str, Any] | None) -> bool:
    """Whether the plan's deliverable has a check tool, so a check step with nothing behind it
    reads "Not checked"."""
    return plan is not None and plan.get("kind") in CHECK_TOOLS


def project(
    plan: Mapping[str, Any] | None,
    *,
    running: bool = False,
    helpers: Mapping[str, str] | None = None,
) -> list[dict[str, Any]]:
    """The plan's items as the person reads them: the model's fields and the engine's ``state``.

    :param running: The Conversation's turn is still running.
    :param helpers: Helper session id -> its status (``family.tree``), read now: a finished Helper
        settles its item before the record has heard of it.
    :returns: ``[{"text", "active"?, "owner"?, "done_when"?, "state"}]``; the model's ``status``
        never travels. A model-claimed tick with no evidence reads ``claimed``, never ``done``; a
        check step with no evidence once nothing runs reads ``not_checked`` (a deliverable with a
        check tool only); an item still doing once nothing runs reads ``stopped``.
    """
    if plan is None:
        return []
    statuses = helpers or {}
    busy = running or any(
        statuses.get(str(item.get("helper_id"))) == _HELPER_WORKING for item in plan["items"]
    )
    out: list[dict[str, Any]] = []
    for item in plan["items"]:
        evidence = item.get("evidence", TODO)
        state = evidence
        if evidence == DOING:
            status = statuses.get(str(item.get("helper_id")))
            if status == _HELPER_WORKING:
                state = DOING
            elif status == _HELPER_OK and item.get("done_when") in (None, HELPER_DONE):
                state = DONE
            elif status is not None and status != _HELPER_OK:
                state = FAILED
            else:
                state = DOING if busy else STOPPED
        elif evidence == TODO:
            if item.get("done_when") == CHECK_RAN and not busy and needs_check(plan):
                state = NOT_CHECKED
            elif item.get("claimed"):
                state = CLAIMED
        projected = {key: item[key] for key in _KEPT_FIELDS if key in item}
        projected["state"] = state
        out.append(projected)
    return out


def helper_ids(plans: Iterable[Mapping[str, Any]]) -> list[str]:
    """The Helpers the plans' steps were given to (their status settles those steps)."""
    return [
        str(item["helper_id"])
        for plan in plans
        for item in plan.get("items", ())
        if item.get("helper_id")
    ]


def plans_from_items(items: Iterable[Mapping[str, Any]]) -> dict[str, dict[str, Any]]:
    """The plans shown in transcript *items* (``to_api_dict`` shape, oldest first), by id, each
    ticked by the evidence that follows it: up to the person's next message, unless it answers
    the plan's question card. Evidence a turn gathered before its plan counts for that plan."""
    listed = list(items)
    outputs = {
        str(i.get("call_id")): i.get("output")
        for i in listed
        if i.get("type") == "function_call_output"
    }
    plans: dict[str, dict[str, Any]] = {}
    events: list[dict[str, Any]] = []
    asked = False
    for item in listed:
        event: dict[str, Any] | None = None
        if item.get("type") == "message" and item.get("role") == "user":
            if item.get("is_system_notice") is True or item.get("is_meta") is True:
                continue
            content = item.get("content") if isinstance(item.get("content"), list) else []
            text = " ".join(
                str(part.get("text") or "") for part in content if isinstance(part, Mapping)
            )
            if is_system_notice_text(text.strip()):
                continue
            if not (asked and any(e["kind"] == "plan" for e in events)):
                events, asked = [], False
                continue
            event, asked = {"kind": ANSWERED}, False
        elif item.get("type") == "function_call" and isinstance(item.get("name"), str):
            call_id = str(item.get("call_id") or "")
            output = outputs.get(call_id)
            event = evidence_for(
                item["name"], output if isinstance(output, str) else None, call_id=call_id
            )
        if event is None:
            continue
        if event["kind"] == "asked":
            asked = True
            continue
        events.append(event)
        plan = replay(events)
        if plan is not None:
            plans[plan["id"]] = plan
    return plans


def plan_views(
    stored: Mapping[str, Mapping[str, Any]],
    items: Iterable[Mapping[str, Any]],
    *,
    running: bool,
    helpers: Mapping[str, str],
) -> dict[str, list[dict[str, Any]]]:
    """Every plan the *items* show, by id, projected: the one its task record keeps (*stored*)
    wins, else the one the items show. The one projection the transcript and the activity read
    (through ``TaskService.plan_views``)."""
    shown = plans_from_items(items)
    return {
        plan_id: project(stored.get(plan_id) or plan, running=running, helpers=helpers)
        for plan_id, plan in shown.items()
    }


#: ``(conversation id, transcript items) -> {plan id: projected items}``: what the transcript and
#: the activity read plans with (``TaskService.plan_views``).
PlanViews = Callable[[str, list[Mapping[str, Any]]], dict[str, list[dict[str, Any]]]]


def plan_reader(state: Any) -> PlanViews | None:
    """The plan projection an app offers (its tasks service, ``app.state.task_service``)."""
    service = getattr(state, "task_service", None)
    return getattr(service, "plan_views", None)


def fold(items: Iterable[Mapping[str, Any]]) -> int:
    """How many earlier steps fold away: the leading done items, less the two kept in view."""
    leading = 0
    for item in items:
        if item.get("state") != DONE:
            break
        leading += 1
    return max(0, leading - 2)


def checked(plan: Mapping[str, Any] | None) -> bool | None:
    """Whether the plan's check ran (``None`` when it has no check step)."""
    checks = [i for i in (plan or {}).get("items", ()) if i.get("done_when") == CHECK_RAN]
    return all(i.get("evidence") == DONE for i in checks) if checks else None
