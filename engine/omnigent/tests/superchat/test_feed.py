"""``/v1/me/topics`` and ``/v1/me/feed``: followed topics and their posts."""

from __future__ import annotations

import json
import uuid
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from omnigent.stores.scheduled_task_store.sqlalchemy_store import SqlAlchemyScheduledTaskStore
from omnigent.superchat.feed.routes import create_feed_router
from omnigent.superchat.feed.topics import cadence_of, is_followed_topic, is_nothing_new

_PARENT = uuid.uuid4().hex
_AGENT = uuid.uuid4().hex


def _msg(item_id: str, role: str, text: str) -> dict[str, Any]:
    kind = "output_text" if role == "assistant" else "input_text"
    return {
        "id": item_id,
        "type": "message",
        "role": role,
        "created_at": 1,
        "content": [{"type": kind, "text": text}],
    }


def _card(item_id: str, call_id: str) -> list[dict[str, Any]]:
    payload = {"card": "stat", "fallback": "Up 3%", "data": {"n": 3}}
    return [
        {"id": item_id, "type": "function_call", "name": "render_card", "call_id": call_id},
        {
            "id": item_id + "o",
            "type": "function_call_output",
            "call_id": call_id,
            "output": json.dumps({"type": "card", **payload}),
        },
    ]


class _ConvStore:
    def __init__(self) -> None:
        self.items: dict[str, list[dict[str, Any]]] = {}

    def list_items(self, conversation_id: str, limit: int = 100, order: str = "asc", **_: Any):
        data = [SimpleNamespace(to_api_dict=lambda i=i: i) for i in self.items[conversation_id]]
        return SimpleNamespace(data=data[:limit])


@pytest.fixture()
def env(db_uri: str):
    store = SqlAlchemyScheduledTaskStore(db_uri)
    convs = _ConvStore()
    app = FastAPI()
    app.include_router(
        create_feed_router(
            scheduled_task_store=store, conversation_store=convs, auth_provider=None
        ),
        prefix="/v1",
    )
    return store, convs, TestClient(app)


def _task(store: SqlAlchemyScheduledTaskStore, name: str, **kw: Any) -> str:
    task_id = uuid.uuid4().hex
    store.create(
        task_id,
        name,
        "p",
        "FREQ=WEEKLY;BYDAY=MO",
        None,
        _AGENT,
        "UTC",
        parent_session_id=_PARENT,
        **kw,
    )
    return task_id


def _run(store, convs, task_id: str, items: list[dict[str, Any]], at: int) -> str:
    conv = uuid.uuid4().hex
    convs.items[conv] = items
    run_id = uuid.uuid4().hex
    store.create_run(
        run_id, task_id, "succeeded", at, conversation_id=conv, fired_at=at, finished_at=at
    )
    return run_id


def test_nothing_new_rule() -> None:
    assert is_nothing_new("Nothing new.", [])
    assert is_nothing_new("  nothing new ", [])
    assert not is_nothing_new("Nothing new in AI, but here is X", [])
    assert not is_nothing_new("Nothing new.", [{"type": "card"}])
    assert cadence_of("FREQ=WEEKLY;BYDAY=MO") == "weekly"
    assert cadence_of("FREQ=MONTHLY") is None


def test_topics_marker_with_legacy_fallback(env) -> None:
    store, _, client = env
    marked = _task(store, "AI agents", agent_type="goal", kind="followed_topic")
    legacy = _task(store, "Old topic", agent_type="worker")
    _task(store, "A goal", agent_type="goal")
    _task(store, "Marked other", agent_type="worker", kind="something_else")
    data = client.get("/v1/me/topics").json()["data"]
    assert {t["id"] for t in data} == {marked, legacy}
    assert next(t for t in data if t["id"] == marked)["cadence"] == "weekly"
    assert is_followed_topic(store.get(marked))


def test_feed_posts_and_nothing_new(env) -> None:
    store, convs, client = env
    topic = _task(store, "AI agents", agent_type="worker", kind="followed_topic")
    news = _run(
        store,
        convs,
        topic,
        [_msg("1", "user", "go"), *_card("2", "c1"), _msg("3", "assistant", "Launch X shipped.")],
        300,
    )
    _run(store, convs, topic, [_msg("4", "assistant", "Nothing new.")], 200)
    older = _run(store, convs, topic, [_msg("5", "assistant", "Older news")], 100)

    page = client.get("/v1/me/feed").json()
    assert [p["run_id"] for p in page["data"]] == [news, older]
    first = page["data"][0]
    assert first["text"] == "Launch X shipped."
    assert first["topic_id"] == topic
    assert first["nothing_new"] is False
    assert first["cards"][0]["card"]["fallback"] == "Up 3%"

    everything = client.get("/v1/me/feed?include_nothing_new=true").json()["data"]
    assert [p["nothing_new"] for p in everything] == [False, True, False]

    one = client.get("/v1/me/feed?limit=1").json()
    assert one["has_more"] is True
    rest = client.get("/v1/me/feed", params={"limit": 5, "before": one["next_cursor"]}).json()
    assert [p["run_id"] for p in rest["data"]] == [older]
    assert rest["has_more"] is False


def test_feed_and_topics_are_redacted(env, monkeypatch: pytest.MonkeyPatch) -> None:
    secret = "tok-feed-0123456789"
    monkeypatch.setenv("FEED_SERVICE_TOKEN", secret)
    store, convs, client = env
    topic = _task(store, f"Watch {secret}", agent_type="worker", kind="followed_topic")
    _run(store, convs, topic, [_msg("1", "assistant", f"Found {secret} in a repo.")], 300)
    for path in ("/v1/me/feed", "/v1/me/topics"):
        raw = client.get(path).text
        assert secret not in raw and "[redacted]" in raw
