"""The task record (ADR 0025): what a deliverable in progress is, how it reads in a turn, and the
one rule for when a turn on it ends well.

Pure: no store, no HTTP. The store keeps :class:`Task` rows; the service applies events to them
with the functions here; the runner writes :func:`task_line` in front of the person's message and
judges each turn with :func:`ends_well` (the scenario evals import the same function).

The lifecycle, written by the engine from what happened, never from the model's word:

* **open** on creation, when work starts: ``deck_new`` (a deck), ``start_helper`` (the kind its
  brief names, :func:`kind_for_brief`), or a Conversation turn's first ``artifact_save`` with no
  open task.
* **building** while the turn that works on it runs, or while a Helper started for it runs.
* **done** when the Conversation turn that saved it ends, or when its Helpers have finished (read
  when the turn their completion notice opens reports its start; a read never closes a task). A
  Helper's own saves are drafts: they add the artifact group and touch ``updated_at``, never
  close it.
* **dropped** after :data:`STALE_AFTER` untouched.

A task of a kind with a check tool (:data:`CHECK_TOOLS`) reads ``checked`` once that tool
succeeded in the Conversation or a Helper of the task; its decision line says so.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from typing import Any

from omnigent.superchat.artifact_kinds import is_deck_name

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
#: How alike a saved file's title and a task's title must be to count as the same deliverable.
MATCH_AT = 0.5
LINE_OPEN = "Open task: "
PICKED_LINE = "They picked {label}. Continue the task; do not plan it again."
#: Deliverable kind -> the tool that checks it; a task of any other kind has no check.
CHECK_TOOLS: Mapping[str, str] = {"deck": "deck_check"}
_NEXT = {OPEN: "build", BUILDING: "check and save"}
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
#: Words of a Helper's brief -> the kind of deliverable it makes (the first kind named wins).
_KIND_BY_WORD = (
    ("deck", ("deck", "slides", "presentation", "pitch")),
    ("sheet", ("sheet", "spreadsheet", "csv", "xlsx")),
    ("page", ("page", "website", "landing", "dashboard", "html")),
    ("document", ("document", "doc", "report", "memo", "letter", "essay", "pdf")),
)


@dataclass
class Task:
    """One deliverable in progress (see ``SqlTask``).

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


def kind_for_name(name: str) -> str:
    """The task kind a saved file of this name delivers."""
    if is_deck_name(name):
        return "deck"
    low = name.lower()
    return next((k for suffix, k in _KIND_BY_SUFFIX.items() if low.endswith(suffix)), "file")


def kind_for_brief(brief: str) -> str:
    """The task kind a Helper started with this brief makes, else ``file``."""
    words = set(re.findall(r"[a-z0-9]+", brief.lower()))
    return next((kind for kind, keys in _KIND_BY_WORD if words & set(keys)), "file")


def _norm(text: str) -> str:
    return " ".join(re.findall(r"[a-z0-9]+", text.lower()))


def _stem(name: str) -> str:
    """A file name without its extensions, as words (``rbc-vs-td.deck.html`` -> ``rbc vs td``)."""
    return _norm(name.split(".", 1)[0].replace("-", " ").replace("_", " "))


def similarity(a: str, b: str) -> float:
    """How alike two titles are, 0 to 1 (case, punctuation and file extensions ignored)."""
    left, right = _norm(a), _norm(b)
    if not left or not right:
        return 0.0
    return SequenceMatcher(None, left, right).ratio()


def best_match(tasks: Iterable[Task], kind: str, title: str, name: str = "") -> Task | None:
    """The active task of *kind* this deliverable is, by file name or title, else ``None``."""
    best: tuple[float, Task] | None = None
    for task in tasks:
        if task.kind != kind or task.status not in ACTIVE:
            continue
        if name and task.fields.get("file") == name:
            return task
        score = max(similarity(task.title, title), similarity(task.title, _stem(name)))
        if score >= MATCH_AT and (best is None or score > best[0]):
            best = (score, task)
    return best[1] if best else None


def record_answer(task: Task, answer: CardAnswer, item_id: str) -> None:
    """Note the person's pick on the task its card asked for.

    What the pick means for the deliverable (a deck's look) is read from the option id by the
    capability that builds it, and comes back on that capability's own event.
    """
    answers = task.fields.setdefault("answers", [])
    answers.append({**answer.to_wire(), "item_id": item_id})
    del answers[:-10]
    task.fields["answered"] = answer.label


def task_line(task: Task) -> str:
    """One line naming an active task and what comes next, e.g.
    ``Open task: deck "RBC vs TD" · look Pitch Deck · data: mock · next: build``."""
    parts = [f'{LINE_OPEN}{task.kind} "{task.title}"' if task.title else LINE_OPEN + task.kind]
    fields = task.fields
    if fields.get("look"):
        parts.append(f"look {fields['look']}")
    if fields.get("data"):
        parts.append(f"data: {fields['data']}")
    if isinstance(fields.get("slides"), int) and fields["slides"] > 0:
        parts.append(f"{fields['slides']} slides")
    if fields.get("answered"):
        parts.append(f"answered: {fields['answered']}")
    nxt = "wait for the helper" if task.helper_running else _NEXT.get(task.status, "build")
    parts.append(f"next: {nxt}")
    return " · ".join(parts)


def prefix_lines(tasks: Iterable[Task], answer: CardAnswer | None) -> list[str]:
    """What goes in front of the person's message: the pick first, then the active tasks (at
    most :data:`MAX_LINES` lines)."""
    lines = [PICKED_LINE.format(label=answer.label)] if answer is not None else []
    lines += [task_line(t) for t in tasks if t.status in ACTIVE]
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


def watched(turn: Turn) -> bool:
    """Whether *turn*'s ending can make it a stall: a person's turn on an open task with no Helper
    of it running. (A step-limit refusal can stall any person's turn.)"""
    return turn.by_person and turn.task_id is not None and not turn.helper_running


def decision_line(task: Task) -> str:
    """The one line a finished task leaves in the working list and the journal, e.g.
    ``RBC vs TD (deck): look Swiss Grid, data mock, 6 slides, checked``; ``checked`` or
    ``not checked`` only for a kind that has a check tool."""
    title = " ".join(task.title.split()) or "Untitled"
    fields = task.fields
    parts = [f"{key} {fields[key]}" for key in ("look", "data") if fields.get(key)]
    slides = fields.get("slides")
    if isinstance(slides, int) and not isinstance(slides, bool) and slides > 0:
        parts.append(f"{slides} slides")
    if task.kind in CHECK_TOOLS:
        parts.append("checked" if fields.get("checked") is True else "not checked")
    head = f"{title} ({task.kind})"
    return f"{head}: {', '.join(parts)}" if parts else head
