"""Tests for :class:`AskService` against an in-memory fake store.

Pure domain logic — no database, no Omnigent runtime. Covers opening,
answering (including the option/ownership/conflict guards), listing, and
expiring.
"""

from __future__ import annotations

import pytest

from omnigent.errors import ErrorCode, OmnigentError
from omnigent.nova._shared import NovaActor
from omnigent.nova.asks.entities import AskAction, AskKind, AskStatus
from omnigent.nova.asks.service import AskService

from ._fakes import InMemoryAskStore

ALICE = NovaActor(user_id="alice@example.com", workspace_id=0)
BOB = NovaActor(user_id="bob@example.com", workspace_id=0)


@pytest.fixture()
def service() -> AskService:
    return AskService(InMemoryAskStore())


# ── open_ask ─────────────────────────────────────────────────────────────


def test_open_ask_persists_and_returns(service: AskService) -> None:
    ask = service.open_ask(actor=ALICE, kind=AskKind.QUESTION, text="Pick a color")
    assert ask.status is AskStatus.OPEN
    assert ask.user_id == "alice@example.com"
    assert ask.answer is None
    assert ask.created_at > 0


def test_open_ask_rejects_empty_text(service: AskService) -> None:
    with pytest.raises(OmnigentError) as excinfo:
        service.open_ask(actor=ALICE, kind=AskKind.QUESTION, text="   ")
    assert excinfo.value.code == ErrorCode.INVALID_INPUT


def test_open_ask_rejects_too_many_actions(service: AskService) -> None:
    actions = tuple(AskAction(id=f"c{i}", label=f"Choice {i}") for i in range(5))
    with pytest.raises(OmnigentError) as excinfo:
        service.open_ask(actor=ALICE, kind=AskKind.QUESTION, text="Pick one", actions=actions)
    assert excinfo.value.code == ErrorCode.INVALID_INPUT


def test_open_ask_rejects_duplicate_action_ids(service: AskService) -> None:
    actions = (AskAction(id="a", label="A"), AskAction(id="a", label="B"))
    with pytest.raises(OmnigentError):
        service.open_ask(actor=ALICE, kind=AskKind.QUESTION, text="Pick one", actions=actions)


# ── answer ───────────────────────────────────────────────────────────────


def test_answer_marks_ask_answered(service: AskService) -> None:
    ask = service.open_ask(actor=ALICE, kind=AskKind.QUESTION, text="Ship it?")
    answered = service.answer(ALICE, ask.id, "yes")
    assert answered.status is AskStatus.ANSWERED
    assert answered.answer == "yes"
    assert answered.answered_at is not None
    assert service.list_open(ALICE) == []


def test_answer_unknown_ask_raises_not_found(service: AskService) -> None:
    with pytest.raises(OmnigentError) as excinfo:
        service.answer(ALICE, "does-not-exist", "yes")
    assert excinfo.value.code == ErrorCode.NOT_FOUND


def test_answer_someone_elses_ask_raises_not_found(service: AskService) -> None:
    ask = service.open_ask(actor=ALICE, kind=AskKind.QUESTION, text="Ship it?")
    with pytest.raises(OmnigentError) as excinfo:
        service.answer(BOB, ask.id, "yes")
    assert excinfo.value.code == ErrorCode.NOT_FOUND


def test_answer_already_answered_raises_conflict(service: AskService) -> None:
    ask = service.open_ask(actor=ALICE, kind=AskKind.QUESTION, text="Ship it?")
    service.answer(ALICE, ask.id, "yes")
    with pytest.raises(OmnigentError) as excinfo:
        service.answer(ALICE, ask.id, "no")
    assert excinfo.value.code == ErrorCode.CONFLICT


def test_answer_must_be_one_of_the_offered_options(service: AskService) -> None:
    actions = (AskAction(id="yes", label="Yes"), AskAction(id="no", label="No"))
    ask = service.open_ask(actor=ALICE, kind=AskKind.APPROVAL, text="Deploy?", actions=actions)
    with pytest.raises(OmnigentError) as excinfo:
        service.answer(ALICE, ask.id, "maybe")
    assert excinfo.value.code == ErrorCode.INVALID_INPUT
    # The valid options still work.
    answered = service.answer(ALICE, ask.id, "yes")
    assert answered.answer == "yes"


def test_free_text_ask_accepts_any_answer(service: AskService) -> None:
    ask = service.open_ask(actor=ALICE, kind=AskKind.QUESTION, text="What's the repo name?")
    answered = service.answer(ALICE, ask.id, "rakazo-engine")
    assert answered.answer == "rakazo-engine"


# ── list_open ────────────────────────────────────────────────────────────


def test_list_open_is_scoped_per_person(service: AskService) -> None:
    service.open_ask(actor=ALICE, kind=AskKind.QUESTION, text="For Alice")
    service.open_ask(actor=BOB, kind=AskKind.QUESTION, text="For Bob")
    assert [a.text for a in service.list_open(ALICE)] == ["For Alice"]
    assert [a.text for a in service.list_open(BOB)] == ["For Bob"]


def test_list_open_excludes_answered(service: AskService) -> None:
    open_ask = service.open_ask(actor=ALICE, kind=AskKind.QUESTION, text="Open")
    answered_ask = service.open_ask(actor=ALICE, kind=AskKind.QUESTION, text="Answered")
    service.answer(ALICE, answered_ask.id, "done")
    assert [a.id for a in service.list_open(ALICE)] == [open_ask.id]


# ── expire_for_session ───────────────────────────────────────────────────


def test_expire_for_session_closes_only_that_sessions_open_asks(service: AskService) -> None:
    in_session = service.open_ask(
        actor=ALICE, kind=AskKind.BLOCKED_TASK, text="Blocked", session_id="conv_1"
    )
    other_session = service.open_ask(
        actor=ALICE, kind=AskKind.QUESTION, text="Elsewhere", session_id="conv_2"
    )
    expired = service.expire_for_session("conv_1")
    assert [a.id for a in expired] == [in_session.id]
    remaining = {a.id for a in service.list_open(ALICE)}
    assert remaining == {other_session.id}


def test_expire_for_session_with_nothing_open_is_a_no_op(service: AskService) -> None:
    assert service.expire_for_session("conv_missing") == []
