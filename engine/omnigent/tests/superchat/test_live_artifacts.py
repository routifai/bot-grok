"""Live artifacts: what an update may change, and the schedule, undo and publish around it."""

from __future__ import annotations

import time
import uuid
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from omnigent.errors import ErrorCode, OmnigentError
from omnigent.stores.artifact_store.local import LocalArtifactStore
from omnigent.stores.scheduled_task_store.sqlalchemy_store import SqlAlchemyScheduledTaskStore
from omnigent.superchat.artifact_kinds import KIND_MIME
from omnigent.superchat.artifacts.store import SqlAlchemyArtifactStore
from omnigent.superchat.live.service import LiveService
from omnigent.superchat.live.store import SqlAlchemyLiveStore

_SESSION = uuid.uuid4().hex
PAGE = (
    b"<!doctype html><html><body>"
    b'<h1 data-superchat-id="title">Prices</h1>'
    b'<p data-superchat-id="btc">Bitcoin: 100</p>'
    b'<p data-superchat-id="eth">Ethereum: 10</p>'
    b"</body></html>"
)


class _Scheduler:
    def __init__(self) -> None:
        self.calls: list[tuple[str, Any]] = []

    def add(self, task: Any) -> None:
        self.calls.append(("add", task.id))

    def update(self, task: Any) -> None:
        self.calls.append(("update", task.state))

    def remove(self, task_id: str) -> None:
        self.calls.append(("remove", task_id))


class _Convs:
    def get_conversation(self, _id: str) -> Any:
        return SimpleNamespace(agent_id=uuid.uuid4().hex)


@pytest.fixture()
def env(db_uri: str, tmp_path: Path):
    blobs = LocalArtifactStore(str(tmp_path / "blobs"))
    artifacts = SqlAlchemyArtifactStore(db_uri, lambda: blobs)
    scheduler = _Scheduler()
    tasks = SqlAlchemyScheduledTaskStore(db_uri)
    service = LiveService(
        artifacts, SqlAlchemyLiveStore(db_uri), tasks, _Convs(), lambda: scheduler
    )
    # The routes note the server loop; here scheduler calls run at once.
    service.loop = SimpleNamespace(call_soon_threadsafe=lambda call, *args: call(*args))
    first = artifacts.create(
        user_id=None, parent_session_id=_SESSION, name="prices.html", title="Prices",
        kind="html", mime=KIND_MIME["html"], data=PAGE, source_path="/ws/prices.html",
    )  # fmt: skip
    service.upsert(first, rrule="FREQ=DAILY;BYHOUR=8;BYMINUTE=0", sources=["https://example.com"])
    return SimpleNamespace(artifacts=artifacts, service=service, scheduler=scheduler, first=first)


def _head(env: Any):
    return env.artifacts.newest(env.first)


def _text(env: Any, element: str) -> str:
    from omnigent.superchat.artifacts.patches import read_text

    return read_text(env.artifacts.read(_head(env)), element) or ""


def _save(env: Any, changes: list[dict[str, Any]], **kw: Any) -> dict[str, Any]:
    return env.service.save(
        _head(env),
        base_version=kw.pop("base_version", _head(env).version),
        changes=changes,
        facts=kw.pop("facts", {"https://example.com": {"hash": "h", "values": {}}}),
        sources=kw.pop("sources", None),
    )


def _hand_edit(env: Any, old: bytes, new: bytes) -> None:
    head = _head(env)
    data = env.artifacts.read(head).replace(old, new)
    saved = env.artifacts.create(
        user_id=None, parent_session_id=_SESSION, name=head.name, title=head.title,
        kind="html", mime=head.mime, data=data, origin="manual", parent_version_id=head.id,
        source_path=head.source_path, edit_summary="edited by hand",
    )  # fmt: skip
    assert saved.version == head.version + 1


def test_update_changes_facts_in_one_update_version(env) -> None:
    out = _save(env, [{"id": "btc", "after": "Bitcoin: 120", "source": "https://example.com"}])
    head = _head(env)
    assert out["version"] == head.version == 2
    assert head.origin == "update" and head.edit_summary == "1 change"
    assert _text(env, "btc") == "Bitcoin: 120" and _text(env, "eth") == "Ethereum: 10"
    live = env.service.live.get(_SESSION, "prices.html")
    assert live.state["written"] == {"btc": "Bitcoin: 120"}
    assert live.state["last_update"]["version"] == 2
    assert live.state["checked_at"] and live.state["misses"] == 0


def test_update_version_is_written_back_like_a_hand_edit(env) -> None:
    _save(env, [{"id": "btc", "after": "Bitcoin: 120"}])
    pending = env.artifacts.pending_manual(user_id=None, parent_session_id=_SESSION)
    assert [(p.version, p.origin) for p in pending] == [(2, "update")]


def test_part_the_person_changed_becomes_a_suggestion(env) -> None:
    _save(env, [{"id": "btc", "after": "Bitcoin: 120"}])
    _hand_edit(env, b"Bitcoin: 120", b"Bitcoin: my guess")
    out = _save(env, [{"id": "btc", "after": "Bitcoin: 130", "source": "s"}])
    assert out["version"] is None and out["applied"] == []
    assert out["suggestions"] == [
        {"id": "btc", "yours": "Bitcoin: my guess", "source_value": "Bitcoin: 130", "source": "s"}
    ]
    assert _text(env, "btc") == "Bitcoin: my guess"
    live = env.service.live.get(_SESSION, "prices.html")
    assert live.state["last_update"]["suggestions"][0]["id"] == "btc"


def test_accepting_a_suggestion_follows_the_source_again(env) -> None:
    _save(env, [{"id": "btc", "after": "Bitcoin: 120"}])
    _hand_edit(env, b"Bitcoin: 120", b"Bitcoin: mine")
    _save(env, [{"id": "btc", "after": "Bitcoin: 130"}])
    created = env.service.accept(_head(env), "btc")
    assert created.origin == "update" and _text(env, "btc") == "Bitcoin: 130"
    state = env.service.live.get(_SESSION, "prices.html").state
    assert state["written"]["btc"] == "Bitcoin: 130"
    assert state["last_update"]["suggestions"] == []
    assert _save(env, [{"id": "btc", "after": "Bitcoin: 140"}])["version"] == created.version + 1


def test_part_the_person_deleted_stays_deleted(env) -> None:
    _save(env, [{"id": "btc", "after": "Bitcoin: 120"}])
    _hand_edit(env, b'<p data-superchat-id="btc">Bitcoin: 120</p>', b"")
    out = _save(env, [{"id": "btc", "after": "Bitcoin: 130"}])
    assert out["removed"] == ["btc"] and out["unplaced"] == [] and out["version"] is None
    assert env.service.live.get(_SESSION, "prices.html").state["misses"] == 0


def test_rejected_value_is_skipped_until_the_source_says_something_else(env) -> None:
    live = env.service.live.get(_SESSION, "prices.html")
    live.state["rejected"] = [["btc", "Bitcoin: 120"]]
    env.service.live.save(live)
    skipped = _save(env, [{"id": "btc", "after": "Bitcoin: 120"}])
    assert skipped["version"] is None and skipped["declined"] == ["btc"]
    assert _text(env, "btc") == "Bitcoin: 100"
    assert _save(env, [{"id": "btc", "after": "Bitcoin: 125"}])["version"] == 2
    assert env.service.live.get(_SESSION, "prices.html").state["rejected"] == []


def test_nothing_changed_makes_no_version(env) -> None:
    out = _save(env, [], facts={"https://example.com": {"hash": "x", "values": {}}})
    assert out["version"] is None and _head(env).version == 1
    state = env.service.live.get(_SESSION, "prices.html").state
    assert state["facts"]["https://example.com"]["hash"] == "x" and state["checked_at"]
    assert state["last_update"] is None


def test_changes_that_cannot_be_placed_pause_the_schedule_at_the_second_run(env) -> None:
    first = _save(env, [{"id": "nope", "after": "x"}])
    assert first["unplaced"] == ["nope"] and first["version"] is None
    live = env.service.live.get(_SESSION, "prices.html")
    assert live.state["misses"] == 1 and "nope" in live.state["open_issue"]
    assert env.service.tasks.get(live.task_id).state == "active"
    _save(env, [{"id": "nope", "after": "x"}])
    live = env.service.live.get(_SESSION, "prices.html")
    assert live.state["misses"] == 2 and live.state["open_issue"]
    assert env.service.tasks.get(live.task_id).state == "paused"
    assert ("update", "paused") in env.scheduler.calls
    assert _head(env).version == 1
    env.service.upsert(env.first, rrule="FREQ=DAILY;BYHOUR=9;BYMINUTE=0")
    live = env.service.live.get(_SESSION, "prices.html")
    assert live.state["misses"] == 0 and env.service.tasks.get(live.task_id).state == "active"


def test_three_failed_runs_in_a_row_pause_and_post_one_note_and_success_resets(env) -> None:
    live = env.service.live.get(_SESSION, "prices.html")
    task = env.service.tasks.get(live.task_id)
    assert env.service.on_run_outcome(task, "your Computer didn't start") is None
    assert env.service.on_run_outcome(task, None) is None  # a success starts the count again
    state = env.service.live.get(_SESSION, "prices.html").state
    assert state["failures"] == 0 and state["last_failure"] is None
    assert env.service.on_run_outcome(task, "a") is None
    assert env.service.on_run_outcome(task, "b") is None
    assert env.service.tasks.get(live.task_id).state == "active"
    note = env.service.on_run_outcome(task, "c")
    assert "paused" in note and "(c)" in note and "live settings" in note
    state = env.service.live.get(_SESSION, "prices.html").state
    assert state["failures"] == 3 and state["last_failure"]["reason"] == "c"
    assert env.service.tasks.get(live.task_id).state == "paused"
    assert ("update", "paused") in env.scheduler.calls
    assert env.service.on_run_outcome(task, "d") is None  # one note only
    env.service.upsert(env.first, rrule="FREQ=DAILY;BYHOUR=9;BYMINUTE=0")
    state = env.service.live.get(_SESSION, "prices.html").state
    assert state["failures"] == 0 and state["last_failure"] is None
    assert env.service.tasks.get(live.task_id).state == "active"


def test_unplaced_counts_even_next_to_applied_changes_and_a_clean_run_clears_it(env) -> None:
    _save(env, [{"id": "nope", "after": "x"}, {"id": "btc", "after": "Bitcoin: 121"}])
    state = env.service.live.get(_SESSION, "prices.html").state
    assert state["misses"] == 1 and "nope" in state["open_issue"]
    _save(env, [])
    state = env.service.live.get(_SESSION, "prices.html").state
    assert state["misses"] == 0 and state["open_issue"] is None


def test_published_copy_stays_pinned_unless_it_follows_updates(env) -> None:
    env.artifacts.publish(env.first, audience="link")
    _save(env, [{"id": "btc", "after": "Bitcoin: 120"}])
    assert env.artifacts.publication_for(env.first).published_version == 1
    live = env.service.live.get(_SESSION, "prices.html")
    live.follow_publish = True
    env.service.live.save(live)
    _save(env, [{"id": "btc", "after": "Bitcoin: 130"}])
    pub = env.artifacts.publication_for(env.first)
    assert pub.published_version == 3 and pub.audience == "link"


def test_undo_restores_the_version_before_and_rejects_what_it_wrote(env) -> None:
    _save(env, [{"id": "btc", "after": "Bitcoin: 120"}])
    restored = env.service.undo(_head(env))
    assert restored.origin == "restore" and _text(env, "btc") == "Bitcoin: 100"
    state = env.service.live.get(_SESSION, "prices.html").state
    assert state["rejected"] == [["btc", "Bitcoin: 120"]] and "btc" not in state["written"]
    skipped = _save(env, [{"id": "btc", "after": "Bitcoin: 120"}])
    assert skipped["version"] is None and skipped["declined"] == ["btc"]
    with pytest.raises(OmnigentError) as exc:
        env.service.undo(_head(env))
    assert exc.value.code == ErrorCode.CONFLICT


def test_undo_is_refused_once_the_person_edited_after_the_update(env) -> None:
    _save(env, [{"id": "btc", "after": "Bitcoin: 120"}])
    _hand_edit(env, b"Ethereum: 10", b"Ethereum: 11")
    with pytest.raises(OmnigentError):
        env.service.undo(_head(env))


def test_a_recent_hand_edit_defers_the_run(env) -> None:
    task = env.service.tasks.get(env.service.live.get(_SESSION, "prices.html").task_id)
    assert env.service.defer_until(task) is None
    _hand_edit(env, b"Ethereum: 10", b"Ethereum: 11")
    assert env.service.defer_until(task) > time.time()
    ctx = env.service.context(_head(env))
    assert ctx["version"] == 2 and ctx["sources"] == ["https://example.com"]
    assert "Ethereum: 11" in ctx["source"]
    _save(env, [{"id": "btc", "after": "Bitcoin: 120"}])
    assert env.service.defer_until(task) is None


def test_stale_base_version_is_a_409(env) -> None:
    _hand_edit(env, b"Ethereum: 10", b"Ethereum: 11")
    with pytest.raises(OmnigentError) as exc:
        _save(env, [{"id": "btc", "after": "Bitcoin: 120"}], base_version=1)
    assert exc.value.code == ErrorCode.ARTIFACT_STALE
    assert _head(env).version == 2


def test_inferred_sources_are_saved(env) -> None:
    _save(env, [], sources=["/ws/data.csv"])
    assert env.service.live.get(_SESSION, "prices.html").sources == ["/ws/data.csv"]


def test_setting_the_schedule_again_changes_the_task_and_stop_removes_it(env) -> None:
    live = env.service.live.get(_SESSION, "prices.html")
    rrule = "FREQ=WEEKLY;BYDAY=MO;BYHOUR=8;BYMINUTE=0"
    again = env.service.upsert(env.first, rrule=rrule, tell="never", follow_publish=True)
    task = env.service.tasks.get(again.task_id)
    assert again.task_id == live.task_id and task.rrule.startswith("FREQ=WEEKLY")
    assert task.kind == "live_artifact" and task.agent_type == "worker"
    assert task.parent_session_id == _SESSION and "prices.html" in task.prompt
    assert (again.tell, again.follow_publish, again.sources) == (
        "never",
        True,
        ["https://example.com"],
    )
    assert env.service.remove(env.first) is True
    assert env.service.tasks.get(live.task_id) is None
    assert env.service.live.get(_SESSION, "prices.html") is None
    assert env.service.remove(env.first) is False
    assert len(env.artifacts.versions(env.first)) == 1


def test_tool_schemas_are_valid_json_schema() -> None:
    # A provider rejects the whole turn when one tool's input schema is invalid.
    from jsonschema import Draft202012Validator

    from omnigent.superchat.live import tools

    for tool in (
        tools.KeepUpdatedTool(),
        tools.StopUpdatingTool(),
        tools.UpdateContextTool(),
        tools.UpdateSaveTool(),
    ):
        Draft202012Validator.check_schema(tool.get_schema()["function"]["parameters"])
