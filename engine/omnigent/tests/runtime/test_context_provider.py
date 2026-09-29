"""Tests for the per-turn deployment context-provider hook.

Covers the no-op-when-unset contract, the wrapped-block append on a
successful fetch, fail-open behavior on timeout/error/non-200, the exact
request contract, and the ``turn_input`` extraction helper — this hook must
never fail or delay a turn (see ``omnigent/runtime/context_provider.py``).
"""

from __future__ import annotations

import json

import httpx
import pytest
import respx

from omnigent.runtime.context_provider import (
    _warned_sessions,
    context_provider_configured,
    extract_turn_input_text,
    fetch_deployment_context,
    forget_session,
)

_URL = "https://example.test/context"


@pytest.fixture(autouse=True)
def _clean_warned_sessions():
    """Isolate the warn-once-per-session bookkeeping across tests."""
    _warned_sessions.clear()
    yield
    _warned_sessions.clear()


# ── unset (no-op) ────────────────────────────────────────────────────


async def test_unset_url_is_a_complete_no_op(monkeypatch: pytest.MonkeyPatch) -> None:
    """No ``OMNIGENT_CONTEXT_PROVIDER_URL``: no fetch, empty string back."""
    monkeypatch.delenv("OMNIGENT_CONTEXT_PROVIDER_URL", raising=False)
    assert not context_provider_configured()
    with respx.mock:
        # No route registered at all — any HTTP call would raise.
        result = await fetch_deployment_context(
            session_id="s1",
            agent_name="agent",
            harness="pi",
            user_id=None,
            labels={},
            turn_input="hello",
        )
    assert result == ""


def test_blank_url_is_treated_as_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OMNIGENT_CONTEXT_PROVIDER_URL", "   ")
    assert not context_provider_configured()


# ── successful fetch ─────────────────────────────────────────────────


async def test_successful_fetch_wraps_instructions(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OMNIGENT_CONTEXT_PROVIDER_URL", _URL)
    monkeypatch.setenv("OMNIGENT_CONTEXT_PROVIDER_SECRET", "sekrit")
    assert context_provider_configured()

    captured: dict[str, object] = {}

    def _responder(request: httpx.Request) -> httpx.Response:
        captured["headers"] = dict(request.headers)
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"instructions": "be extra careful today"})

    with respx.mock:
        respx.post(_URL).mock(side_effect=_responder)
        result = await fetch_deployment_context(
            session_id="sess-1",
            agent_name="research-agent",
            harness="pi",
            user_id="alice@example.com",
            labels={"team": "growth"},
            turn_input="what's the weather",
        )

    assert result == "\n\n<deployment_context>\nbe extra careful today\n</deployment_context>"
    assert captured["headers"]["authorization"] == "Bearer sekrit"
    assert captured["body"] == {
        "session_id": "sess-1",
        "agent_name": "research-agent",
        "harness": "pi",
        "user_id": "alice@example.com",
        "labels": {"team": "growth"},
        "turn_input": "what's the weather",
    }


async def test_empty_instructions_response_yields_empty_string(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OMNIGENT_CONTEXT_PROVIDER_URL", _URL)
    with respx.mock:
        respx.post(_URL).mock(return_value=httpx.Response(200, json={"instructions": ""}))
        result = await fetch_deployment_context(
            session_id="s2",
            agent_name="a",
            harness="codex",
            user_id=None,
            labels={},
            turn_input="",
        )
    assert result == ""


async def test_no_secret_configured_sends_empty_bearer(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OMNIGENT_CONTEXT_PROVIDER_URL", _URL)
    monkeypatch.delenv("OMNIGENT_CONTEXT_PROVIDER_SECRET", raising=False)
    captured: dict[str, object] = {}

    def _responder(request: httpx.Request) -> httpx.Response:
        captured["auth"] = request.headers.get("authorization")
        return httpx.Response(200, json={"instructions": ""})

    with respx.mock:
        respx.post(_URL).mock(side_effect=_responder)
        await fetch_deployment_context(
            session_id="s3",
            agent_name="a",
            harness="codex",
            user_id=None,
            labels={},
            turn_input="",
        )
    assert captured["auth"] == "Bearer "


async def test_turn_input_is_truncated_to_4000_chars(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OMNIGENT_CONTEXT_PROVIDER_URL", _URL)
    captured: dict[str, object] = {}

    def _responder(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"instructions": ""})

    long_input = "x" * 5000
    with respx.mock:
        respx.post(_URL).mock(side_effect=_responder)
        await fetch_deployment_context(
            session_id="s4",
            agent_name="a",
            harness="codex",
            user_id=None,
            labels={},
            turn_input=long_input,
        )
    assert len(captured["body"]["turn_input"]) == 4000


async def test_response_instructions_capped_at_64kib(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OMNIGENT_CONTEXT_PROVIDER_URL", _URL)
    huge = "a" * (100 * 1024)
    with respx.mock:
        respx.post(_URL).mock(return_value=httpx.Response(200, json={"instructions": huge}))
        result = await fetch_deployment_context(
            session_id="s5",
            agent_name="a",
            harness="codex",
            user_id=None,
            labels={},
            turn_input="",
        )
    inner = result.removeprefix("\n\n<deployment_context>\n").removesuffix(
        "\n</deployment_context>"
    )
    assert len(inner.encode("utf-8")) <= 64 * 1024


# ── fail-open on timeout / error / non-200 ───────────────────────────


async def test_timeout_fails_open(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OMNIGENT_CONTEXT_PROVIDER_URL", _URL)
    with respx.mock:
        respx.post(_URL).mock(side_effect=httpx.TimeoutException("slow"))
        result = await fetch_deployment_context(
            session_id="s6",
            agent_name="a",
            harness="codex",
            user_id=None,
            labels={},
            turn_input="",
        )
    assert result == ""


async def test_non_200_fails_open(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OMNIGENT_CONTEXT_PROVIDER_URL", _URL)
    with respx.mock:
        respx.post(_URL).mock(return_value=httpx.Response(500))
        result = await fetch_deployment_context(
            session_id="s7",
            agent_name="a",
            harness="codex",
            user_id=None,
            labels={},
            turn_input="",
        )
    assert result == ""


async def test_malformed_json_response_fails_open(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OMNIGENT_CONTEXT_PROVIDER_URL", _URL)
    with respx.mock:
        respx.post(_URL).mock(return_value=httpx.Response(200, text="not json"))
        result = await fetch_deployment_context(
            session_id="s8",
            agent_name="a",
            harness="codex",
            user_id=None,
            labels={},
            turn_input="",
        )
    assert result == ""


async def test_connection_error_fails_open(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OMNIGENT_CONTEXT_PROVIDER_URL", _URL)
    with respx.mock:
        respx.post(_URL).mock(side_effect=httpx.ConnectError("refused"))
        result = await fetch_deployment_context(
            session_id="s9",
            agent_name="a",
            harness="codex",
            user_id=None,
            labels={},
            turn_input="",
        )
    assert result == ""


async def test_failure_warns_once_per_session(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    monkeypatch.setenv("OMNIGENT_CONTEXT_PROVIDER_URL", _URL)
    with caplog.at_level("WARNING"), respx.mock:
        respx.post(_URL).mock(return_value=httpx.Response(500))
        for _ in range(3):
            await fetch_deployment_context(
                session_id="repeat-session",
                agent_name="a",
                harness="codex",
                user_id=None,
                labels={},
                turn_input="",
            )
    warnings = [r for r in caplog.records if r.levelname == "WARNING"]
    assert len(warnings) == 1

    forget_session("repeat-session")
    with caplog.at_level("WARNING"), respx.mock:
        respx.post(_URL).mock(return_value=httpx.Response(500))
        await fetch_deployment_context(
            session_id="repeat-session",
            agent_name="a",
            harness="codex",
            user_id=None,
            labels={},
            turn_input="",
        )
    warnings_after_forget = [
        r
        for r in caplog.records
        if r.levelname == "WARNING" and "repeat-session" in r.getMessage()
    ]
    assert len(warnings_after_forget) == 2  # the original + the one after forget_session


# ── extract_turn_input_text ──────────────────────────────────────────


def test_extract_turn_input_text_from_plain_string() -> None:
    assert extract_turn_input_text("hello there") == "hello there"


def test_extract_turn_input_text_from_flat_blocks() -> None:
    content = [{"type": "input_text", "text": "hello"}, {"type": "input_text", "text": "world"}]
    assert extract_turn_input_text(content) == "hello\nworld"


def test_extract_turn_input_text_from_history_shape_uses_last_user_message() -> None:
    content = [
        {"role": "user", "content": "first"},
        {"role": "assistant", "content": "reply"},
        {"role": "user", "content": [{"type": "input_text", "text": "second"}]},
    ]
    assert extract_turn_input_text(content) == "second"


def test_extract_turn_input_text_ignores_non_user_roles() -> None:
    content = [{"role": "assistant", "content": "ignored"}]
    assert extract_turn_input_text(content) == ""


def test_extract_turn_input_text_handles_none_and_empty() -> None:
    assert extract_turn_input_text(None) == ""
    assert extract_turn_input_text([]) == ""
