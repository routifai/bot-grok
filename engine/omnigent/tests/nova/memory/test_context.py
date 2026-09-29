"""Tests for :func:`omnigent.nova.memory.context.context_section`.

Covers the privacy gate (rule 3 in ``nova/README.md``: private sessions
only), redaction, and the "nothing to say" case — against a fake store
patched onto ``memory._runtime_store``, so these don't touch a database.
"""

from __future__ import annotations

import pytest

from omnigent.nova import memory
from omnigent.nova._shared import ContextRequest, NovaActor, Scope
from omnigent.nova.memory.context import context_section
from omnigent.nova.memory.entities import MemoryNote, NoteKind

ACTOR = NovaActor(user_id="alice@example.com", workspace_id=0)


def _note(content: str) -> MemoryNote:
    return MemoryNote(
        id="note-1",
        user_id=ACTOR.user_id,
        workspace_id=ACTOR.workspace_id,
        kind=NoteKind.ABOUT_YOU,
        path="MEMORY.md",
        content=content,
        revision=1,
        created_at=0,
        updated_at=0,
    )


class _FakeStore:
    def __init__(self, notes: list[MemoryNote]) -> None:
        self._notes = notes

    def list_notes(self, actor: NovaActor) -> list[MemoryNote]:
        assert actor == ACTOR
        return self._notes


def _request(**overrides: object) -> ContextRequest:
    defaults: dict[str, object] = {
        "actor": ACTOR,
        "scope": Scope.PRIVATE,
        "session_id": "conv_abc123",
        "turn_input": "",
        "timezone": "UTC",
        "secrets": (),
    }
    defaults.update(overrides)
    return ContextRequest(**defaults)  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_returns_none_outside_private_scope(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(memory, "_runtime_store", lambda: _FakeStore([_note("Likes tea.")]))
    result = await context_section(_request(scope=Scope.PROJECT))
    assert result is None


@pytest.mark.asyncio
async def test_returns_none_when_there_are_no_notes(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(memory, "_runtime_store", lambda: _FakeStore([]))
    result = await context_section(_request())
    assert result is None


@pytest.mark.asyncio
async def test_renders_notes_for_a_private_session(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(memory, "_runtime_store", lambda: _FakeStore([_note("Likes tea.")]))
    section = await context_section(_request())
    assert section is not None
    assert section.key == "memory"
    assert section.priority == 20
    assert "Likes tea." in section.body


@pytest.mark.asyncio
async def test_redacts_secrets(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        memory, "_runtime_store", lambda: _FakeStore([_note("api key sk-secret-123")])
    )
    section = await context_section(_request(secrets=("sk-secret-123",)))
    assert section is not None
    assert "sk-secret-123" not in section.body
    assert "[redacted]" in section.body
