"""Tests for ``omnigent.nova.episodes.context.context_section``."""

from __future__ import annotations

import pytest

from omnigent.nova import episodes as _episodes
from omnigent.nova._shared import ContextRequest, NovaActor, Scope
from omnigent.nova.episodes.context import context_section
from omnigent.nova.episodes.entities import Episode
from omnigent.nova.episodes.sqlalchemy_store import SqlAlchemyEpisodeStore

ALICE = NovaActor(user_id="alice@example.com", workspace_id=0)


def _request(**overrides: object) -> ContextRequest:
    defaults: dict[str, object] = {
        "actor": ALICE,
        "scope": Scope.PRIVATE,
        "session_id": "conv_abc",
        "turn_input": "",
        "timezone": "UTC",
        "secrets": (),
    }
    defaults.update(overrides)
    return ContextRequest(**defaults)  # type: ignore[arg-type]


@pytest.fixture()
def configured_store(db_uri: str, monkeypatch: pytest.MonkeyPatch) -> SqlAlchemyEpisodeStore:
    """A real store, wired the way ``routes.create_router`` wires it."""
    store = SqlAlchemyEpisodeStore(db_uri)
    monkeypatch.setattr(_episodes, "_runtime_store", lambda: store)
    return store


def _record(
    store: SqlAlchemyEpisodeStore, *, title: str, summary: str, created_at: int
) -> Episode:
    return store.upsert(
        actor=ALICE,
        session_id="conv_abc",
        turn_id=f"resp_{title}",
        title=title,
        summary=summary,
        tools=("web_search",),
        links=(),
        created_at=created_at,
    )


@pytest.mark.asyncio
async def test_returns_none_for_project_scope(configured_store: SqlAlchemyEpisodeStore) -> None:
    _record(configured_store, title="Mortgage rates", summary="Found a good rate.", created_at=1)
    section = await context_section(_request(scope=Scope.PROJECT, turn_input="mortgage rates"))
    assert section is None


@pytest.mark.asyncio
async def test_returns_none_when_nothing_matches(configured_store: SqlAlchemyEpisodeStore) -> None:
    _record(configured_store, title="Booked a dentist", summary="Tuesday.", created_at=1)
    section = await context_section(_request(turn_input="mortgage rates"))
    assert section is None


@pytest.mark.asyncio
async def test_returns_top_matches_private_scope_only(
    configured_store: SqlAlchemyEpisodeStore,
) -> None:
    _record(configured_store, title="Compared mortgage rates", summary="Acme Bank.", created_at=1)
    _record(configured_store, title="Booked a dentist", summary="Tuesday.", created_at=2)
    section = await context_section(_request(turn_input="mortgage rates"))
    assert section is not None
    assert section.key == "past_episodes"
    assert section.priority == 40
    assert "Compared mortgage rates" in section.body
    assert "Booked a dentist" not in section.body


@pytest.mark.asyncio
async def test_caps_top_matches_at_three(configured_store: SqlAlchemyEpisodeStore) -> None:
    for i in range(5):
        _record(
            configured_store,
            title=f"Compared mortgage rates {i}",
            summary="Acme Bank.",
            created_at=i,
        )
    section = await context_section(_request(turn_input="mortgage rates"))
    assert section is not None
    assert section.body.count("Compared mortgage rates") == 3


@pytest.mark.asyncio
async def test_redacts_secrets(configured_store: SqlAlchemyEpisodeStore) -> None:
    _record(
        configured_store,
        title="mortgage rates",
        summary="api key is sk-super-secret",
        created_at=1,
    )
    section = await context_section(
        _request(turn_input="mortgage rates", secrets=("sk-super-secret",))
    )
    assert section is not None
    assert "sk-super-secret" not in section.body
    assert "[redacted]" in section.body


@pytest.mark.asyncio
async def test_scoped_to_the_requesting_actor(configured_store: SqlAlchemyEpisodeStore) -> None:
    configured_store.upsert(
        actor=NovaActor(user_id="bob@example.com", workspace_id=0),
        session_id="conv_bob",
        turn_id="resp_1",
        title="Compared mortgage rates for Bob",
        summary="Acme Bank.",
        tools=("web_search",),
        links=(),
        created_at=1,
    )
    section = await context_section(_request(turn_input="mortgage rates"))
    assert section is None
