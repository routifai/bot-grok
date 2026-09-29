"""Tests for :func:`omnigent.nova.skills.context.context_section`.

Covers the privacy gate (rule 3 in ``nova/README.md``: private sessions
only), redaction, and the "nothing to say" case — against a fake service
patched onto ``skills._runtime_service``, so these don't touch a database.
"""

from __future__ import annotations

import pytest

from omnigent.nova import skills
from omnigent.nova._shared import ContextRequest, NovaActor, Scope
from omnigent.nova.skills.context import context_section
from omnigent.nova.skills.entities import OfferStatus, Skill, SkillOffer

ACTOR = NovaActor(user_id="alice@example.com", workspace_id=0)


def _skill(name: str, description: str = "d") -> Skill:
    return Skill(
        id="skill-1",
        user_id=ACTOR.user_id,
        workspace_id=ACTOR.workspace_id,
        name=name,
        description=description,
        content="content",
        created_at=0,
        updated_at=0,
    )


def _offer(name: str) -> SkillOffer:
    return SkillOffer(
        id="offer-1",
        user_id=ACTOR.user_id,
        workspace_id=ACTOR.workspace_id,
        name=name,
        description="d",
        content="content",
        status=OfferStatus.OPEN,
        created_at=0,
        decided_at=None,
    )


class _FakeService:
    def __init__(self, skills_: list[Skill], offers: list[SkillOffer]) -> None:
        self._skills = skills_
        self._offers = offers

    def list_skills(self, actor: NovaActor) -> list[Skill]:
        assert actor == ACTOR
        return self._skills

    def open_offers(self, actor: NovaActor) -> list[SkillOffer]:
        assert actor == ACTOR
        return self._offers


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


def _wire(monkeypatch: pytest.MonkeyPatch, skills_: list[Skill], offers: list[SkillOffer]) -> None:
    monkeypatch.setattr(skills, "_runtime_service", lambda: _FakeService(skills_, offers))


@pytest.mark.asyncio
async def test_returns_none_outside_private_scope(monkeypatch: pytest.MonkeyPatch) -> None:
    _wire(monkeypatch, [_skill("Weekly report")], [])
    result = await context_section(_request(scope=Scope.PROJECT))
    assert result is None


@pytest.mark.asyncio
async def test_returns_none_when_nothing_saved_or_offered(monkeypatch: pytest.MonkeyPatch) -> None:
    _wire(monkeypatch, [], [])
    result = await context_section(_request())
    assert result is None


@pytest.mark.asyncio
async def test_lists_saved_skills(monkeypatch: pytest.MonkeyPatch) -> None:
    _wire(monkeypatch, [_skill("Weekly report", "Summarize the week.")], [])
    section = await context_section(_request())
    assert section is not None
    assert section.key == "skills"
    assert section.priority == 45
    assert "Weekly report" in section.body
    assert "Summarize the week." in section.body


@pytest.mark.asyncio
async def test_lists_open_offers(monkeypatch: pytest.MonkeyPatch) -> None:
    _wire(monkeypatch, [], [_offer("Weekly report")])
    section = await context_section(_request())
    assert section is not None
    assert "Weekly report" in section.body
    assert "awaiting an answer" in section.body


@pytest.mark.asyncio
async def test_redacts_secrets(monkeypatch: pytest.MonkeyPatch) -> None:
    _wire(monkeypatch, [_skill("sk-secret-123")], [])
    section = await context_section(_request(secrets=("sk-secret-123",)))
    assert section is not None
    assert "sk-secret-123" not in section.body
    assert "[redacted]" in section.body
