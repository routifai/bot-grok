"""Tests for :func:`omnigent.nova.context.composer.compose`.

Exercises section ordering, per-section and total budgets, drop order on
overflow, provider-failure tolerance, redaction, and the timezone line — all
against fake section providers patched onto ``_registry.section_providers``,
so these tests do not depend on any other primitive existing yet.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable

import pytest

from omnigent.nova import _registry
from omnigent.nova._shared import ContextRequest, ContextSection, NovaActor, Scope
from omnigent.nova.context.composer import MAX_TOTAL_BYTES, compose
from omnigent.nova.context.instructions import STATIC_INSTRUCTIONS

SectionProvider = Callable[[ContextRequest], Awaitable[ContextSection | None]]


def _request(**overrides: object) -> ContextRequest:
    """A private-scope request with sane defaults, overridable per test."""
    defaults: dict[str, object] = {
        "actor": NovaActor(user_id="alice@example.com", workspace_id=0),
        "scope": Scope.PRIVATE,
        "session_id": "conv_abc123",
        "turn_input": "",
        "timezone": "UTC",
        "secrets": (),
    }
    defaults.update(overrides)
    return ContextRequest(**defaults)  # type: ignore[arg-type]


def _provider(section: ContextSection | None) -> SectionProvider:
    """A provider that always returns the given section (or None)."""

    async def provide(request: ContextRequest) -> ContextSection | None:
        del request
        return section

    return provide


def _failing_provider(error: Exception) -> SectionProvider:
    async def provide(request: ContextRequest) -> ContextSection | None:
        del request
        raise error

    return provide


def _patch_providers(monkeypatch: pytest.MonkeyPatch, providers: list[SectionProvider]) -> None:
    monkeypatch.setattr(_registry, "section_providers", lambda: providers)


# ── static content always present ───────────────────────────────────────────


@pytest.mark.asyncio
async def test_includes_static_instructions(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_providers(monkeypatch, [])
    result = await compose(_request())
    assert STATIC_INSTRUCTIONS in result


@pytest.mark.asyncio
async def test_no_providers_is_static_text_only(monkeypatch: pytest.MonkeyPatch) -> None:
    """With no primitives contributing sections, the result is just the fixed preamble."""
    _patch_providers(monkeypatch, [])
    result = await compose(_request())
    assert "<goals>" not in result and "</goals>" not in result


@pytest.mark.asyncio
async def test_timezone_line_uses_request_timezone(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_providers(monkeypatch, [])
    result = await compose(_request(timezone="America/Toronto"))
    assert "America/Toronto" in result
    assert "present moment" in result


@pytest.mark.asyncio
async def test_unknown_timezone_falls_back_to_utc(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_providers(monkeypatch, [])
    result = await compose(_request(timezone="Not/AZone"))
    assert "(UTC):" in result


# ── ordering and budgets ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_sections_ordered_by_priority(monkeypatch: pytest.MonkeyPatch) -> None:
    low = ContextSection(key="low_priority", body="second", priority=90)
    high = ContextSection(key="high_priority", body="first", priority=10)
    # Registered out of order; the composer must still emit low-number-first.
    _patch_providers(monkeypatch, [_provider(low), _provider(high)])
    result = await compose(_request())
    assert result.index("<high_priority>") < result.index("<low_priority>")


@pytest.mark.asyncio
async def test_section_wrapped_in_its_key_tag(monkeypatch: pytest.MonkeyPatch) -> None:
    section = ContextSection(key="goals", body="Active goal: ship the thing.", priority=20)
    _patch_providers(monkeypatch, [_provider(section)])
    result = await compose(_request())
    assert "<goals>\nActive goal: ship the thing.\n</goals>" in result


@pytest.mark.asyncio
async def test_none_sections_are_skipped(monkeypatch: pytest.MonkeyPatch) -> None:
    section = ContextSection(key="goals", body="present", priority=20)
    _patch_providers(monkeypatch, [_provider(None), _provider(section)])
    result = await compose(_request())
    assert "<goals>" in result


@pytest.mark.asyncio
async def test_per_section_max_bytes_caps_body(monkeypatch: pytest.MonkeyPatch) -> None:
    body = "\n".join(f"line {i}" for i in range(1000))
    section = ContextSection(key="memory", body=body, priority=20, max_bytes=64)
    _patch_providers(monkeypatch, [_provider(section)])
    result = await compose(_request())
    start = result.index("<memory>") + len("<memory>\n")
    end = result.index("</memory>")
    rendered_body = result[start:end]
    assert len(rendered_body.encode("utf-8")) <= 64
    assert "line 999" not in result


@pytest.mark.asyncio
async def test_total_budget_drops_lowest_priority_first(monkeypatch: pytest.MonkeyPatch) -> None:
    # Two sections, each comfortably under its own max_bytes but together
    # forcing the composer past MAX_TOTAL_BYTES: the lower-priority one must
    # be dropped whole, never truncated.
    _patch_providers(monkeypatch, [])
    baseline = len((await compose(_request())).encode("utf-8"))
    remaining = MAX_TOTAL_BYTES - baseline

    big_body = "x" * (remaining - 500)
    important = ContextSection(
        key="important", body=big_body, priority=10, max_bytes=MAX_TOTAL_BYTES
    )
    trivial = ContextSection(
        key="trivial", body="y" * 5000, priority=90, max_bytes=MAX_TOTAL_BYTES
    )
    _patch_providers(monkeypatch, [_provider(trivial), _provider(important)])
    result = await compose(_request())
    assert "<important>" in result
    assert "<trivial>" not in result
    assert len(result.encode("utf-8")) <= MAX_TOTAL_BYTES


@pytest.mark.asyncio
async def test_failing_provider_is_skipped_others_still_run(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ok = ContextSection(key="goals", body="still here", priority=20)
    _patch_providers(monkeypatch, [_failing_provider(RuntimeError("boom")), _provider(ok)])
    result = await compose(_request())
    assert "<goals>" in result
    assert "still here" in result


# ── redaction and privacy ───────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_redacts_secrets_everywhere(monkeypatch: pytest.MonkeyPatch) -> None:
    section = ContextSection(key="memory", body="api key is sk-super-secret-value", priority=20)
    _patch_providers(monkeypatch, [_provider(section)])
    result = await compose(_request(secrets=("sk-super-secret-value",)))
    assert "sk-super-secret-value" not in result
    assert "[redacted]" in result


@pytest.mark.asyncio
async def test_project_scope_passed_through_to_providers(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[Scope] = []

    async def capture(request: ContextRequest) -> ContextSection | None:
        seen.append(request.scope)
        return None

    _patch_providers(monkeypatch, [capture])
    await compose(_request(scope=Scope.PROJECT))
    assert seen == [Scope.PROJECT]


@pytest.mark.asyncio
async def test_project_scope_with_no_primitives_is_static_only() -> None:
    """Against the real registry (no primitive has landed a context.py yet),
    any scope produces only the fixed static text — nothing primitive-specific
    can leak because nothing is registered to contribute it."""
    result = await compose(_request(scope=Scope.PROJECT))
    assert STATIC_INSTRUCTIONS in result
    assert "<goals>\n" not in result and "<memory>\n" not in result
