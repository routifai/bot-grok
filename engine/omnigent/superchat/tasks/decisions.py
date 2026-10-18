"""A finished task's decision, written once into the working list and the journal (ADR 0027).

The line is the task's ``fields["decision"]``, composed once by
:func:`~omnigent.superchat.tasks.record.decision_line` when the task closes, e.g.
``RBC vs TD (deck): look Pitch Deck, data mock, 8 slides, checked``. It is written verbatim:

* by the server, where the task closes (:func:`record_decision`): a ``d-`` entry of the
  Conversation's working list, the pending-entry session label (``omnigent.state_add.<tag>``)
  the next checkpoint writes into the state file and clears, the same path a ``state_close``
  takes (``context/state_file.py``);
* by the runner, which owns the journal files, when the event that closed the task answers
  (:func:`journal_decision`): a line of today's journal naming the task's files and Helpers, so
  recall finds it by its subject words at once.

Both are written once per task id. The tag is the title's words (``d-rbc-vs-td``), so a later
decision on the same subject replaces the entry instead of adding a second one. Failures are
logged, never raised: the task is done either way.
"""

from __future__ import annotations

import asyncio
import logging
import re
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from omnigent.context.state_file import ADDED_ENTRY_MAX_CHARS, TAG_ID_MAX_CHARS, entry_label_key
from omnigent.runner.memory import files
from omnigent.stores import ConversationStore
from omnigent.superchat.tasks.record import Task

_logger = logging.getLogger(__name__)

#: Words of the title the tag keeps.
_TAG_WORDS = 6
#: The task field that says its decision is in the working list (the line written).
RECORDED = "decision_recorded"
#: Task ids whose decision this runner journaled (a repeat is skipped).
_journaled: set[str] = set()


def decision_tag(title: str, kind: str = "task", task_id: str = "") -> str:
    """The working-list id of a task's decision: ``d-`` and the title's first words."""
    words = re.findall(r"[a-z0-9]+", title.lower())[:_TAG_WORDS]
    if not words:
        words = [kind or "task", *re.findall(r"[a-z0-9]+", task_id)[:1]]
    return ("d-" + "-".join(words))[:TAG_ID_MAX_CHARS].rstrip("-")


def record_decision(conversations: ConversationStore, task: Task) -> bool:
    """Put a closed task's ``fields["decision"]`` in its Conversation's working list, once per
    task (the caller saves the task, which then carries :data:`RECORDED`). Never raises.

    :returns: Whether the entry was written now.
    """
    line = str(task.fields.get("decision") or "")[:ADDED_ENTRY_MAX_CHARS]
    if not line or task.fields.get(RECORDED) == line:
        return False
    tag = decision_tag(task.title, task.kind, task.id)
    try:
        conversations.set_labels(task.conversation_id, {entry_label_key(tag): line})
    except Exception:  # the task is done either way
        _logger.warning("decision: could not add %s to the working list", tag, exc_info=True)
        return False
    task.fields[RECORDED] = line
    return True


async def journal_decision(
    conversation_id: str, task: Mapping[str, Any], *, workspace: Path | None = None
) -> None:
    """Journal a closed task's decision (its wire form), once per task id. Never raises."""
    fields = task.get("fields") if isinstance(task.get("fields"), Mapping) else {}
    line = fields.get("decision") if isinstance(fields, Mapping) else None
    task_id = str(task.get("id") or "")
    if not isinstance(line, str) or not line or not task_id or task_id in _journaled:
        return
    _journaled.add(task_id)
    try:
        refs = {
            key: [str(v) for v in task.get(field) or []]
            for key, field in (("artifacts", "artifact_group_ids"), ("helpers", "helper_ids"))
            if task.get(field)
        }
        entry = files.journal_line(conversation_id, f"Decision: {line}", refs=refs or None)
        if workspace is None:
            # Deferred: ``knowledge`` imports the artifacts feature, which imports this module.
            from omnigent.superchat.knowledge.runtime import default_workspace

            workspace = default_workspace()
        await asyncio.to_thread(files.append_lines, workspace, [entry], skip_present=True)
    except Exception:  # a copy must never fail the task
        _logger.warning("decision: could not journal task %s", task_id, exc_info=True)
