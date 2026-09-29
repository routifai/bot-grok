"""Tests for the ``nova_recall_episodes`` built-in tool."""

from __future__ import annotations

import json
from dataclasses import dataclass

import pytest

from omnigent.entities.conversation import Conversation
from omnigent.nova._shared import NovaActor
from omnigent.nova.episodes.entities import Episode
from omnigent.nova.episodes.store import EpisodeStore
from omnigent.nova.episodes.tools import TOOLS, NovaRecallEpisodesTool
from omnigent.tools.base import ToolContext

SESSION_ID = "conv_abc"
ALICE = NovaActor(user_id="alice@example.com", workspace_id=0)


def _episode(*, title: str, summary: str, created_at: int, episode_id: str = "e" * 32) -> Episode:
    return Episode(
        id=episode_id,
        workspace_id=0,
        user_id="alice@example.com",
        session_id=SESSION_ID,
        turn_id="resp_1",
        title=title,
        summary=summary,
        tools=(),
        links=(),
        created_at=created_at,
    )


class _FakeEpisodeStore(EpisodeStore):
    def __init__(self, episodes: list[Episode]) -> None:
        super().__init__("memory://")
        self._episodes = episodes

    def upsert(
        self,
        *,
        actor: NovaActor,
        session_id: str,
        turn_id: str,
        title: str,
        summary: str,
        tools: tuple[str, ...],
        links: tuple[str, ...],
        created_at: int,
    ) -> Episode:  # pragma: no cover — unused here
        raise NotImplementedError

    def list_recent(self, *, actor: NovaActor, limit: int) -> list[Episode]:
        return [e for e in self._episodes if e.user_id == actor.user_id][:limit]

    def delete(self, episode_id: str, *, actor: NovaActor) -> bool:  # pragma: no cover
        raise NotImplementedError


@dataclass
class _FakeConversationStore:
    conversation: Conversation | None
    owner_user_id: str | None

    def get_conversation(self, conversation_id: str) -> Conversation | None:
        del conversation_id
        return self.conversation

    def get_session_owner(self, conversation_id: str, *, owner_only: bool = False) -> str | None:
        del conversation_id, owner_only
        return self.owner_user_id


def _conversation(labels: dict[str, str] | None = None) -> Conversation:
    return Conversation(
        id=SESSION_ID,
        created_at=1_700_000_000,
        updated_at=1_700_000_000,
        root_conversation_id=SESSION_ID,
        labels={"nova.scope": "private"} if labels is None else labels,
    )


def _ctx() -> ToolContext:
    return ToolContext(task_id="task_1", agent_id="agent_1", conversation_id=SESSION_ID)


def _patch_conversation_store(
    monkeypatch: pytest.MonkeyPatch, conversation_store: _FakeConversationStore
) -> None:
    import omnigent.runtime as runtime_module

    monkeypatch.setattr(runtime_module, "get_conversation_store", lambda: conversation_store)


def test_registered_under_its_name() -> None:
    assert "nova_recall_episodes" in TOOLS
    assert TOOLS["nova_recall_episodes"]({}).__class__ is NovaRecallEpisodesTool


def test_ranks_matching_episodes(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_conversation_store(
        monkeypatch,
        _FakeConversationStore(conversation=_conversation(), owner_user_id="alice@example.com"),
    )
    store = _FakeEpisodeStore(
        [
            _episode(
                title="Compared mortgage rates",
                summary="Acme Bank had the best rate.",
                created_at=1_700_000_000,
                episode_id="a" * 32,
            ),
            _episode(
                title="Booked a dentist appointment",
                summary="Next Tuesday.",
                created_at=1_700_000_100,
                episode_id="b" * 32,
            ),
        ]
    )
    tool = NovaRecallEpisodesTool(store=store)

    result = json.loads(tool.invoke(json.dumps({"query": "mortgage rates"}), _ctx()))

    assert len(result["episodes"]) == 1
    assert result["episodes"][0]["title"] == "Compared mortgage rates"
    assert "note" not in result


def test_falls_back_to_recent_when_nothing_matches(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_conversation_store(
        monkeypatch,
        _FakeConversationStore(conversation=_conversation(), owner_user_id="alice@example.com"),
    )
    store = _FakeEpisodeStore(
        [_episode(title="Booked a dentist appointment", summary="Next Tuesday.", created_at=1)]
    )
    tool = NovaRecallEpisodesTool(store=store)

    result = json.loads(tool.invoke(json.dumps({"query": "mortgage rates"}), _ctx()))

    assert len(result["episodes"]) == 1
    assert "note" in result
    assert "most recent" in result["note"]


def test_no_episodes_at_all(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_conversation_store(
        monkeypatch,
        _FakeConversationStore(conversation=_conversation(), owner_user_id="alice@example.com"),
    )
    store = _FakeEpisodeStore([])
    tool = NovaRecallEpisodesTool(store=store)

    result = json.loads(tool.invoke(json.dumps({"query": "anything"}), _ctx()))

    assert result["episodes"] == []
    assert result["note"] == "No past episodes yet."


def test_requires_query_argument(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_conversation_store(
        monkeypatch,
        _FakeConversationStore(conversation=_conversation(), owner_user_id="alice@example.com"),
    )
    store = _FakeEpisodeStore([_episode(title="T", summary="S", created_at=1)])
    tool = NovaRecallEpisodesTool(store=store)

    # No query at all still returns the most-recent fallback rather than erroring.
    result = json.loads(tool.invoke(json.dumps({}), _ctx()))
    assert len(result["episodes"]) == 1


def test_rejects_non_private_session(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_conversation_store(
        monkeypatch,
        _FakeConversationStore(
            conversation=_conversation(labels={"nova.scope": "project"}),
            owner_user_id="alice@example.com",
        ),
    )
    store = _FakeEpisodeStore([_episode(title="T", summary="S", created_at=1)])
    tool = NovaRecallEpisodesTool(store=store)

    result = json.loads(tool.invoke(json.dumps({"query": "t"}), _ctx()))

    assert "error" in result
    assert "episodes" not in result


def test_rejects_when_session_has_no_owner(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_conversation_store(
        monkeypatch,
        _FakeConversationStore(conversation=_conversation(), owner_user_id=None),
    )
    store = _FakeEpisodeStore([])
    tool = NovaRecallEpisodesTool(store=store)

    result = json.loads(tool.invoke(json.dumps({"query": "t"}), _ctx()))

    assert "error" in result


def test_requires_a_session() -> None:
    tool = NovaRecallEpisodesTool(store=_FakeEpisodeStore([]))
    ctx = ToolContext(task_id="task_1", agent_id="agent_1", conversation_id=None)

    result = json.loads(tool.invoke(json.dumps({"query": "t"}), ctx))

    assert "error" in result


def test_falls_back_to_the_runtime_store_when_none_injected(
    monkeypatch: pytest.MonkeyPatch, db_uri: str
) -> None:
    """With no ``store=`` given, the tool reads this primitive's shared runtime store."""
    _patch_conversation_store(
        monkeypatch,
        _FakeConversationStore(conversation=_conversation(), owner_user_id="alice@example.com"),
    )
    from omnigent.nova import episodes as _episodes
    from omnigent.nova.episodes.sqlalchemy_store import SqlAlchemyEpisodeStore

    monkeypatch.setattr(_episodes, "_runtime_store", lambda: SqlAlchemyEpisodeStore(db_uri))
    tool = NovaRecallEpisodesTool()  # no store injected

    result = json.loads(tool.invoke(json.dumps({"query": "t"}), _ctx()))

    assert result["episodes"] == []


def test_clamps_limit_to_valid_range(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_conversation_store(
        monkeypatch,
        _FakeConversationStore(conversation=_conversation(), owner_user_id="alice@example.com"),
    )
    store = _FakeEpisodeStore(
        [
            _episode(title=f"mortgage rates {i}", summary="", created_at=1_700_000_000 + i)
            for i in range(20)
        ]
    )
    tool = NovaRecallEpisodesTool(store=store)

    result = json.loads(tool.invoke(json.dumps({"query": "mortgage rates", "limit": 999}), _ctx()))

    assert len(result["episodes"]) == 10  # clamped to the max
