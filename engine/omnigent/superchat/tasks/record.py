"""The task record (ADR 0025): what a deliverable in progress is, and how it reads in a turn.

Pure: no store, no HTTP. The store keeps :class:`Task` rows; the routes apply events to them with
the functions here; the runner writes :func:`task_line` in front of the person's message.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from typing import Any

from omnigent.superchat.decks.names import is_deck_name

KINDS = ("deck", "page", "document", "sheet", "file")
OPEN, BUILDING, DONE, DROPPED = "open", "building", "done", "dropped"
STATUSES = (OPEN, BUILDING, DONE, DROPPED)
#: Statuses a turn still works on: they go in front of the person's message.
ACTIVE = (OPEN, BUILDING)
#: At most this many task lines go in front of a message.
MAX_LINES = 5
#: How alike a saved file's title and a task's title must be to count as the same deliverable.
MATCH_AT = 0.5
LINE_OPEN = "Open task: "
PICKED_LINE = "They picked {label}. Continue the task; do not plan it again."
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


@dataclass
class Task:
    """One deliverable in progress (see ``SqlTask``)."""

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

    def to_wire(self) -> dict[str, Any]:
        """The task as the routes return it."""
        return {
            "id": self.id,
            "kind": self.kind,
            "title": self.title,
            "fields": self.fields,
            "status": self.status,
            "artifact_group_ids": self.artifact_group_ids,
            "helper_ids": self.helper_ids,
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


def record_answer(
    task: Task, answer: CardAnswer, item_id: str, look: tuple[str, str] | None
) -> None:
    """Note the person's pick on *task*; *look* is ``(theme id, name)`` of a theme it picks."""
    answers = task.fields.setdefault("answers", [])
    answers.append({**answer.to_wire(), "item_id": item_id})
    del answers[:-10]
    if look is not None and task.kind == "deck":
        task.fields["look_id"], task.fields["look"] = look
        task.fields["look_from"] = "picked"
    else:
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
    nxt = "wait for the helper" if task.helper_ids else _NEXT.get(task.status, "build")
    parts.append(f"next: {nxt}")
    return " · ".join(parts)


def prefix_lines(tasks: Iterable[Task], answer: CardAnswer | None) -> list[str]:
    """What goes in front of the person's message: the pick first, then the active tasks
    (at most :data:`MAX_LINES` lines)."""
    lines = [PICKED_LINE.format(label=answer.label)] if answer is not None else []
    lines += [task_line(t) for t in tasks if t.status in ACTIVE]
    return lines[:MAX_LINES]
