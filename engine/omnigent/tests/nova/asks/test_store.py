"""Tests for :class:`SqlAlchemyAskStore` against a real SQLite database.

Exercises create/get/list/set_status/expire against the actual migration
(``nova04asks_nova_asks.py``), including workspace/owner scoping and the
elicitation-dedup unique index.
"""

from __future__ import annotations

import pytest

from omnigent.errors import ErrorCode, OmnigentError
from omnigent.nova._shared import new_id, now_s
from omnigent.nova.asks.entities import Ask, AskAction, AskKind, AskStatus
from omnigent.nova.asks.sqlalchemy_store import SqlAlchemyAskStore


@pytest.fixture()
def store(db_uri: str) -> SqlAlchemyAskStore:
    return SqlAlchemyAskStore(db_uri)


def _ask(**overrides: object) -> Ask:
    defaults: dict[str, object] = {
        "id": new_id(),
        "workspace_id": 0,
        "user_id": "alice@example.com",
        "session_id": None,
        "kind": AskKind.QUESTION,
        "text": "Pick a color",
        "detail": None,
        "actions": (),
        "status": AskStatus.OPEN,
        "answer": None,
        "elicitation_id": None,
        "goal_id": None,
        "task_id": None,
        "created_at": now_s(),
        "answered_at": None,
    }
    defaults.update(overrides)
    return Ask(**defaults)  # type: ignore[arg-type]


# ── create / get ─────────────────────────────────────────────────────────


def test_create_round_trips_every_field(store: SqlAlchemyAskStore) -> None:
    actions = (AskAction(id="a", label="Option A"), AskAction(id="b", label="Option B"))
    ask = _ask(actions=actions, detail="More context", session_id=new_id())
    store.create(ask)
    got = store.get(ask.id, user_id="alice@example.com")
    assert got == ask


def test_get_missing_returns_none(store: SqlAlchemyAskStore) -> None:
    assert store.get(new_id(), user_id="alice@example.com") is None


def test_get_scoped_to_owner(store: SqlAlchemyAskStore) -> None:
    ask = _ask(user_id="alice@example.com")
    store.create(ask)
    assert store.get(ask.id, user_id="bob@example.com") is None


def test_create_duplicate_elicitation_raises_already_exists(store: SqlAlchemyAskStore) -> None:
    store.create(_ask(elicitation_id="elicit_abc"))
    with pytest.raises(OmnigentError) as excinfo:
        store.create(_ask(elicitation_id="elicit_abc"))
    assert excinfo.value.code == ErrorCode.ALREADY_EXISTS


def test_create_allows_many_asks_with_no_elicitation(store: SqlAlchemyAskStore) -> None:
    # NULL elicitation_id must not collide under the unique index.
    store.create(_ask(elicitation_id=None))
    store.create(_ask(elicitation_id=None))  # must not raise


def test_get_by_elicitation_finds_the_mirroring_ask(store: SqlAlchemyAskStore) -> None:
    ask = _ask(elicitation_id="elicit_xyz")
    store.create(ask)
    found = store.get_by_elicitation("elicit_xyz")
    assert found is not None
    assert found.id == ask.id


def test_get_by_elicitation_unknown_returns_none(store: SqlAlchemyAskStore) -> None:
    assert store.get_by_elicitation("elicit_nope") is None


# ── list_open ────────────────────────────────────────────────────────────


def test_list_open_is_newest_first(store: SqlAlchemyAskStore) -> None:
    first = _ask(created_at=100)
    second = _ask(created_at=200)
    store.create(first)
    store.create(second)
    result = store.list_open(user_id="alice@example.com")
    assert [a.id for a in result] == [second.id, first.id]


def test_list_open_excludes_answered_and_expired(store: SqlAlchemyAskStore) -> None:
    open_ask = _ask()
    answered_ask = _ask(status=AskStatus.ANSWERED, answer="yes", answered_at=now_s())
    expired_ask = _ask(status=AskStatus.EXPIRED, answered_at=now_s())
    for a in (open_ask, answered_ask, expired_ask):
        store.create(a)
    result = store.list_open(user_id="alice@example.com")
    assert [a.id for a in result] == [open_ask.id]


def test_list_open_respects_limit(store: SqlAlchemyAskStore) -> None:
    for i in range(5):
        store.create(_ask(created_at=i))
    assert len(store.list_open(user_id="alice@example.com", limit=2)) == 2


def test_list_open_scoped_to_owner(store: SqlAlchemyAskStore) -> None:
    store.create(_ask(user_id="alice@example.com"))
    store.create(_ask(user_id="bob@example.com"))
    assert len(store.list_open(user_id="alice@example.com")) == 1


# ── set_status ───────────────────────────────────────────────────────────


def test_set_status_answers_an_open_ask(store: SqlAlchemyAskStore) -> None:
    ask = _ask()
    store.create(ask)
    updated = store.set_status(
        ask.id,
        user_id="alice@example.com",
        status=AskStatus.ANSWERED,
        answer="yes",
        answered_at=42,
    )
    assert updated is not None
    assert updated.status is AskStatus.ANSWERED
    assert updated.answer == "yes"
    assert updated.answered_at == 42


def test_set_status_is_a_no_op_once_already_closed(store: SqlAlchemyAskStore) -> None:
    ask = _ask()
    store.create(ask)
    store.set_status(
        ask.id,
        user_id="alice@example.com",
        status=AskStatus.ANSWERED,
        answer="first",
        answered_at=1,
    )
    unchanged = store.set_status(
        ask.id,
        user_id="alice@example.com",
        status=AskStatus.ANSWERED,
        answer="second",
        answered_at=2,
    )
    assert unchanged is not None
    assert unchanged.answer == "first"
    assert unchanged.answered_at == 1


def test_set_status_unknown_ask_returns_none(store: SqlAlchemyAskStore) -> None:
    result = store.set_status(
        new_id(), user_id="alice@example.com", status=AskStatus.ANSWERED, answer="x", answered_at=1
    )
    assert result is None


def test_set_status_wrong_owner_returns_none(store: SqlAlchemyAskStore) -> None:
    ask = _ask(user_id="alice@example.com")
    store.create(ask)
    result = store.set_status(
        ask.id, user_id="bob@example.com", status=AskStatus.ANSWERED, answer="x", answered_at=1
    )
    assert result is None


# ── expire_open_for_session ──────────────────────────────────────────────


def test_expire_open_for_session_closes_only_open_rows_in_that_session(
    store: SqlAlchemyAskStore,
) -> None:
    session_id = new_id()
    open_in_session = _ask(session_id=session_id)
    answered_in_session = _ask(session_id=session_id, status=AskStatus.ANSWERED, answered_at=1)
    open_elsewhere = _ask(session_id=new_id())
    for a in (open_in_session, answered_in_session, open_elsewhere):
        store.create(a)

    expired = store.expire_open_for_session(session_id, now=999)
    assert [a.id for a in expired] == [open_in_session.id]
    assert expired[0].status is AskStatus.EXPIRED
    assert expired[0].answered_at == 999
    # Untouched rows keep their original state.
    answered_row = store.get(answered_in_session.id, user_id="alice@example.com")
    assert answered_row is not None
    assert answered_row.status is AskStatus.ANSWERED
    elsewhere_row = store.get(open_elsewhere.id, user_id="alice@example.com")
    assert elsewhere_row is not None
    assert elsewhere_row.status is AskStatus.OPEN
