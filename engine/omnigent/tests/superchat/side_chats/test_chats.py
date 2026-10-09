"""Unit tests for ``omnigent.superchat.side_chats.chats``: side_chat_open eligibility and
request bodies, the auto-archive sweep, and the unarchive-on-message rule.

No DB, no server, no live calls — a tiny in-memory fake stands in for
``ConversationStore`` (only the handful of methods this module calls).
"""

from __future__ import annotations

from dataclasses import dataclass, field

import pytest

from omnigent.superchat.side_chats.chats import (
    ARCHIVE_AFTER_SECONDS_ENV,
    DEFAULT_ARCHIVE_AFTER_SECONDS,
    build_side_chat_blank_create_body,
    build_side_chat_fork_body,
    maybe_unarchive_on_user_message,
    refuse_side_chat_open,
    resolve_archive_after_seconds,
)

_SUPERSIDE = {"omnigent.context.mode": "superside-chat"}
_SIDE_CHAT = {**_SUPERSIDE, "omnigent.side_chat": "1"}


# ── refuse_side_chat_open ──────────────────────────────────────────────────


def test_refuses_outside_superside_chat_mode() -> None:
    assert refuse_side_chat_open(labels={}, kind="default", parent_session_id=None) is not None


def test_refuses_rollover_mode_too() -> None:
    """Rollover (native-CLI) is a different mode value, never superside-chat."""
    labels = {"omnigent.context.mode": "rollover"}
    assert refuse_side_chat_open(labels=labels, kind="default", parent_session_id=None) is not None


def test_refuses_from_a_side_chat() -> None:
    reason = refuse_side_chat_open(labels=_SIDE_CHAT, kind="default", parent_session_id=None)
    assert reason is not None
    assert "Side Chat" in reason


def test_refuses_from_a_sub_agent_by_kind() -> None:
    reason = refuse_side_chat_open(labels=_SUPERSIDE, kind="sub_agent", parent_session_id=None)
    assert reason is not None
    assert "Sub-agent" in reason


def test_refuses_from_a_sub_agent_by_parent_session_id() -> None:
    """A sub-agent's ``kind`` may read 'default' on some paths; parent_session_id
    alone is enough to refuse."""
    reason = refuse_side_chat_open(
        labels=_SUPERSIDE, kind="default", parent_session_id="conv_parent"
    )
    assert reason is not None


def test_allowed_from_the_super_chat() -> None:
    assert refuse_side_chat_open(labels=_SUPERSIDE, kind="default", parent_session_id=None) is None


# ── request bodies ──────────────────────────────────────────────────────


def test_fork_body_has_side_chat_flag_and_title() -> None:
    body = build_side_chat_fork_body("Checking the spreadsheet")
    assert body == {"side_chat": True, "title": "Checking the spreadsheet"}


def test_fork_body_leaves_an_untitled_chat_untitled() -> None:
    # An empty title, not an omitted one: the fork route would name it "Fork of …",
    # which stops the first message from titling it.
    assert build_side_chat_fork_body(None) == {"side_chat": True, "title": ""}
    assert build_side_chat_fork_body("") == {"side_chat": True, "title": ""}


def test_blank_create_body_carries_discovery_labels() -> None:
    body = build_side_chat_blank_create_body(agent_id="ag_123", title="Unrelated thing")
    assert body["agent_id"] == "ag_123"
    assert body["title"] == "Unrelated thing"
    assert body["labels"] == {
        "omnigent.context.mode": "superside-chat",
        "omnigent.side_chat": "1",
        "omnigent.side_chat.start": "blank",
    }


# ── resolve_archive_after_seconds ───────────────────────────────────────


def test_default_archive_after_seconds_is_30_days(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(ARCHIVE_AFTER_SECONDS_ENV, raising=False)
    assert resolve_archive_after_seconds() == DEFAULT_ARCHIVE_AFTER_SECONDS
    assert DEFAULT_ARCHIVE_AFTER_SECONDS == 2592000


def test_archive_after_seconds_reads_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(ARCHIVE_AFTER_SECONDS_ENV, "3600")
    assert resolve_archive_after_seconds() == 3600


def test_archive_after_seconds_falls_back_on_garbage(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(ARCHIVE_AFTER_SECONDS_ENV, "not-a-number")
    assert resolve_archive_after_seconds() == DEFAULT_ARCHIVE_AFTER_SECONDS


def test_archive_after_seconds_falls_back_on_non_positive(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(ARCHIVE_AFTER_SECONDS_ENV, "0")
    assert resolve_archive_after_seconds() == DEFAULT_ARCHIVE_AFTER_SECONDS
    monkeypatch.setenv(ARCHIVE_AFTER_SECONDS_ENV, "-5")
    assert resolve_archive_after_seconds() == DEFAULT_ARCHIVE_AFTER_SECONDS


@dataclass
class _FakeConversation:
    id: str
    updated_at: int
    archived: bool = False
    labels: dict[str, str] = field(default_factory=dict)


class _FakeConversationStore:
    """Minimal stand-in: only the methods ``sweep_side_chats`` calls."""

    def __init__(self, conversations: list[_FakeConversation]) -> None:
        # Sorted ascending by updated_at, as the real store's
        # ``sort_by="updated_at", order="asc"`` would return.
        self._conversations = sorted(conversations, key=lambda c: c.updated_at)

    def update_conversation(self, conversation_id: str, *, archived: bool | None = None) -> None:
        for conv in self._conversations:
            if conv.id == conversation_id and archived is not None:
                conv.archived = archived

    def get_conversation(self, conversation_id: str) -> _FakeConversation | None:
        return next((c for c in self._conversations if c.id == conversation_id), None)


# ── maybe_unarchive_on_user_message ──────────────────────────────────────


def test_unarchives_an_archived_side_chat() -> None:
    store = _FakeConversationStore(
        [_FakeConversation("side", updated_at=0, archived=True, labels=_SIDE_CHAT)]
    )
    assert maybe_unarchive_on_user_message(store, "side") is True
    assert store.get_conversation("side").archived is False


def test_does_not_unarchive_the_super_chat() -> None:
    store = _FakeConversationStore(
        [_FakeConversation("super", updated_at=0, archived=True, labels=_SUPERSIDE)]
    )
    assert maybe_unarchive_on_user_message(store, "super") is False
    assert store.get_conversation("super").archived is True


def test_noop_when_not_archived() -> None:
    store = _FakeConversationStore(
        [_FakeConversation("side", updated_at=0, archived=False, labels=_SIDE_CHAT)]
    )
    assert maybe_unarchive_on_user_message(store, "side") is False


def test_noop_when_conversation_unknown() -> None:
    store = _FakeConversationStore([])
    assert maybe_unarchive_on_user_message(store, "nope") is False
