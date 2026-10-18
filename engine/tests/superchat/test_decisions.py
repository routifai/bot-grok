"""A done task's decision line: the working list (the pending-entry label) and the journal."""

from __future__ import annotations

from pathlib import Path

from omnigent.context.state_file import (
    entries,
    entry_label_key,
    parse,
    pending_entries,
    reconcile,
)
from omnigent.stores.conversation_store.sqlalchemy_store import SqlAlchemyConversationStore
from omnigent.superchat.tasks import decisions
from omnigent.superchat.tasks.decisions import (
    RECORDED,
    decision_tag,
    journal_decision,
    record_decision,
)
from omnigent.superchat.tasks.record import Task

TODAY = "2026-10-17"
LINE = "RBC vs TD (deck): look Pitch Deck, data mock, 8 slides, checked"


def _task(chat: str = "chat", **fields: object) -> Task:
    return Task(
        id="t1",
        owner="me",
        conversation_id=chat,
        kind="deck",
        title="RBC vs TD",
        fields={"decision": LINE, **fields},
        artifact_group_ids=["a" * 32],
        helper_ids=["h1"],
    )


def test_the_tag_is_the_titles_words() -> None:
    assert decision_tag("RBC vs TD", "deck", "t1") == "d-rbc-vs-td"
    assert decision_tag("", "deck", "t1") == "d-deck-t1"


def test_pending_entry_lands_in_the_working_list() -> None:
    labels = {entry_label_key("d-rbc-vs-td"): "RBC vs TD (deck): checked", "other": "x"}
    adds = pending_entries(labels)
    assert adds == {"d-rbc-vs-td": "RBC vs TD (deck): checked"}
    previous = (
        "Working list\n- [t-budget · 2026-10-01] Spring budget\n- [d-rbc-vs-td · 2026-10-01] old"
    )
    out = reconcile(previous, previous, adds=adds, today=TODAY, count=len)
    entry = entries(parse(out.text))["d-rbc-vs-td"]
    assert entry.body == "RBC vs TD (deck): checked" and entry.date == TODAY
    assert "t-budget" in entries(parse(out.text))
    fresh = reconcile(None, "Working list", adds=adds, today=TODAY, count=len)
    assert f"- [d-rbc-vs-td · {TODAY}] RBC vs TD (deck): checked" in fresh.text


def test_cleared_label_is_not_pending() -> None:
    assert pending_entries({entry_label_key("d-x"): ""}) == {}


def test_the_decision_goes_verbatim_into_the_working_list_once(db_uri: str) -> None:
    conversations = SqlAlchemyConversationStore(db_uri)
    chat = conversations.create_conversation().id
    task = _task(chat)
    assert record_decision(conversations, task) is True
    labels = conversations.get_conversation(chat).labels
    assert labels[entry_label_key("d-rbc-vs-td")] == LINE
    assert task.fields[RECORDED] == LINE
    assert record_decision(conversations, task) is False  # once per task
    assert record_decision(conversations, _task(chat, decision="")) is False


def test_a_working_list_failure_is_logged_never_raised(caplog) -> None:
    class Broken:
        def set_labels(self, *_args: object) -> None:
            raise RuntimeError("down")

    assert record_decision(Broken(), _task()) is False  # type: ignore[arg-type]
    assert "could not add d-rbc-vs-td" in caplog.text


async def test_the_journal_has_the_line_once_per_task(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(decisions, "_journaled", set())
    wire = _task().to_wire()
    for _ in range(2):
        await journal_decision("chat", wire, workspace=tmp_path)
    journal = "".join(p.read_text() for p in (tmp_path / "memory" / "journal").glob("*.md"))
    assert journal.count(f"Decision: {LINE}") == 1
    assert f"artifacts:{'a' * 32}" in journal and "helpers:h1" in journal
    await journal_decision("chat", {"id": "t2", "fields": {}}, workspace=tmp_path)
    assert "t2" not in decisions._journaled
