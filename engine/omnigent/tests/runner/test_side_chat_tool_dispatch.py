"""Tests for the runner-side ``side_chat_open`` dispatch.

``_execute_side_chat_open`` (``omnigent.superchat.side_chats.handlers``) is a thin
wrapper over ``POST /v1/sessions/{id}/side_chats`` — the one implementation
also used by the web app's "+ New side chat" (see
``omnigent/superchat/side_chats/routes.py``). These tests mock
that single endpoint instead of running a live server.
"""

from __future__ import annotations

import json

import httpx
import pytest

from omnigent.runner.tool_dispatch import (
    _granted_tool_names,
    _ungranted_tool_reason,
)
from omnigent.spec.types import AgentSpec
from omnigent.superchat.side_chats.handlers import _execute_side_chat_open

CALLER = "conv_super_chat"
_SUPERSIDE = {"omnigent.context.mode": "superside-chat"}
_SIDE_CHAT = {**_SUPERSIDE, "omnigent.side_chat": "1"}
_SIDE_CHATS_PATH = f"/v1/sessions/{CALLER}/side_chats"


def _make_spec() -> AgentSpec:
    return AgentSpec(
        spec_version=1, skills=[], mcp_servers=[], local_tools=[], skills_filter="none"
    )


def _client(handler: httpx.MockTransport) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://server")


def _no_calls_expected_client() -> httpx.AsyncClient:
    """A client that fails the test if the dispatcher makes any HTTP call."""

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError(f"unexpected call to {request.url.path}")

    return _client(handler)


# ── Missing server access / session id ──────────────────────────────────


@pytest.mark.asyncio
async def test_requires_server_client() -> None:
    result = json.loads(
        await _execute_side_chat_open(
            {"title": "t", "start": "blank"},
            server_client=None,
            conversation_id=CALLER,
            labels=_SUPERSIDE,
        )
    )
    assert "error" in result


@pytest.mark.asyncio
async def test_requires_conversation_id() -> None:
    client = httpx.AsyncClient(base_url="http://server")
    try:
        result = json.loads(
            await _execute_side_chat_open(
                {"title": "t", "start": "blank"},
                server_client=client,
                conversation_id=None,
                labels=_SUPERSIDE,
            )
        )
    finally:
        await client.aclose()
    assert "error" in result


# ── Argument validation ───────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_requires_nonempty_title() -> None:
    client = httpx.AsyncClient(base_url="http://server")
    try:
        result = json.loads(
            await _execute_side_chat_open(
                {"title": "", "start": "blank"},
                server_client=client,
                conversation_id=CALLER,
                labels=_SUPERSIDE,
            )
        )
    finally:
        await client.aclose()
    assert "error" in result


@pytest.mark.asyncio
async def test_requires_valid_start() -> None:
    client = httpx.AsyncClient(base_url="http://server")
    try:
        result = json.loads(
            await _execute_side_chat_open(
                {"title": "t", "start": "sideways"},
                server_client=client,
                conversation_id=CALLER,
                labels=_SUPERSIDE,
            )
        )
    finally:
        await client.aclose()
    assert "error" in result


# ── Local refusal fast path (no network call) ─────────────────────────────
# ``labels`` alone (already in hand from the dispatch context) decides
# these two; no round trip is made.


@pytest.mark.asyncio
async def test_refuses_outside_superside_chat_mode_without_a_call() -> None:
    client = _no_calls_expected_client()
    try:
        result = json.loads(
            await _execute_side_chat_open(
                {"title": "t", "start": "blank"},
                server_client=client,
                conversation_id=CALLER,
                labels={},
            )
        )
    finally:
        await client.aclose()
    assert "error" in result


@pytest.mark.asyncio
async def test_refuses_from_a_side_chat_without_a_call() -> None:
    client = _no_calls_expected_client()
    try:
        result = json.loads(
            await _execute_side_chat_open(
                {"title": "t", "start": "blank"},
                server_client=client,
                conversation_id=CALLER,
                labels=_SIDE_CHAT,
            )
        )
    finally:
        await client.aclose()
    assert "error" in result
    assert "Side Chat" in result["error"]


# ── Server-side refusal (the route re-checks authoritatively) ────────────


@pytest.mark.asyncio
async def test_refusal_from_a_sub_agent_is_surfaced() -> None:
    """``labels`` alone can't tell a Sub-agent from the Super Chat; the
    route does (it reads the caller's stored ``kind`` / parent), and the
    tool must surface that refusal."""

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == _SIDE_CHATS_PATH
        return httpx.Response(
            403,
            json={
                "error": {
                    "code": "forbidden",
                    "message": (
                        "side_chat_open can only be called from the Super "
                        "Chat, not from a Sub-agent"
                    ),
                }
            },
        )

    client = _client(handler)
    try:
        result = json.loads(
            await _execute_side_chat_open(
                {"title": "t", "start": "blank"},
                server_client=client,
                conversation_id=CALLER,
                labels=_SUPERSIDE,
            )
        )
    finally:
        await client.aclose()
    assert "error" in result
    assert "Sub-agent" in result["error"]


@pytest.mark.asyncio
async def test_network_error_posting_the_route_is_reported() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    client = _client(handler)
    try:
        result = json.loads(
            await _execute_side_chat_open(
                {"title": "t", "start": "blank"},
                server_client=client,
                conversation_id=CALLER,
                labels=_SUPERSIDE,
            )
        )
    finally:
        await client.aclose()
    assert "error" in result


# ── with_context ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_with_context_posts_start_and_title() -> None:
    seen: list[tuple[str, dict[str, object]]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == _SIDE_CHATS_PATH
        seen.append((request.url.path, json.loads(request.content)))
        return httpx.Response(
            201,
            json={
                "conversation_id": "conv_fork_1",
                "title": "Continuing the topic",
                "start": "with_context",
            },
        )

    client = _client(handler)
    try:
        result = json.loads(
            await _execute_side_chat_open(
                {"title": "Continuing the topic", "start": "with_context"},
                server_client=client,
                conversation_id=CALLER,
                labels=_SUPERSIDE,
            )
        )
    finally:
        await client.aclose()
    assert result == {
        "conversation_id": "conv_fork_1",
        "title": "Continuing the topic",
        "start": "with_context",
    }
    assert seen == [(_SIDE_CHATS_PATH, {"start": "with_context", "title": "Continuing the topic"})]


@pytest.mark.asyncio
async def test_route_error_response_is_reported() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == _SIDE_CHATS_PATH
        return httpx.Response(
            400, json={"error": {"code": "invalid_input", "message": "bad fork"}}
        )

    client = _client(handler)
    try:
        result = json.loads(
            await _execute_side_chat_open(
                {"title": "t", "start": "with_context"},
                server_client=client,
                conversation_id=CALLER,
                labels=_SUPERSIDE,
            )
        )
    finally:
        await client.aclose()
    assert "error" in result
    assert "bad fork" in result["error"]


# ── blank ──────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_blank_posts_start_and_title() -> None:
    seen: list[dict[str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == _SIDE_CHATS_PATH
        seen.append(json.loads(request.content))
        return httpx.Response(
            201,
            json={
                "conversation_id": "conv_blank_1",
                "title": "Unrelated thing",
                "start": "blank",
            },
        )

    client = _client(handler)
    try:
        result = json.loads(
            await _execute_side_chat_open(
                {"title": "Unrelated thing", "start": "blank"},
                server_client=client,
                conversation_id=CALLER,
                labels=_SUPERSIDE,
            )
        )
    finally:
        await client.aclose()
    assert result == {
        "conversation_id": "conv_blank_1",
        "title": "Unrelated thing",
        "start": "blank",
    }
    assert seen == [{"start": "blank", "title": "Unrelated thing"}]


@pytest.mark.asyncio
async def test_blank_without_caller_agent_binding_is_reported() -> None:
    """The agent-binding check now lives server-side; the tool just
    surfaces whatever the route reports."""

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == _SIDE_CHATS_PATH
        return httpx.Response(
            400,
            json={
                "error": {
                    "code": "invalid_input",
                    "message": "side_chat_open: caller session has no agent binding",
                }
            },
        )

    client = _client(handler)
    try:
        result = json.loads(
            await _execute_side_chat_open(
                {"title": "t", "start": "blank"},
                server_client=client,
                conversation_id=CALLER,
                labels=_SUPERSIDE,
            )
        )
    finally:
        await client.aclose()
    assert "error" in result


# ── first_message ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_first_message_is_included_in_the_request_body() -> None:
    seen: list[dict[str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == _SIDE_CHATS_PATH
        seen.append(json.loads(request.content))
        return httpx.Response(
            201, json={"conversation_id": "conv_blank_1", "title": "t", "start": "blank"}
        )

    client = _client(handler)
    try:
        result = json.loads(
            await _execute_side_chat_open(
                {"title": "t", "start": "blank", "first_message": "let's dig into this"},
                server_client=client,
                conversation_id=CALLER,
                labels=_SUPERSIDE,
            )
        )
    finally:
        await client.aclose()
    assert result["conversation_id"] == "conv_blank_1"
    assert seen == [{"start": "blank", "title": "t", "first_message": "let's dig into this"}]


@pytest.mark.asyncio
async def test_message_delivery_failure_is_reported() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == _SIDE_CHATS_PATH
        return httpx.Response(
            500,
            json={
                "error": {
                    "code": "internal_error",
                    "message": "side_chat_open: message delivery failed for conv_blank_1: 400",
                }
            },
        )

    client = _client(handler)
    try:
        result = json.loads(
            await _execute_side_chat_open(
                {"title": "t", "start": "blank", "first_message": "hi"},
                server_client=client,
                conversation_id=CALLER,
                labels=_SUPERSIDE,
            )
        )
    finally:
        await client.aclose()
    assert "error" in result


# ── Grant gate: advertised only where actually callable ─────────────────


def test_granted_tool_names_excludes_side_chat_open_without_superside_chat() -> None:
    spec = _make_spec()
    assert "side_chat_open" not in _granted_tool_names(spec, "claude-sdk")


def test_granted_tool_names_excludes_side_chat_open_for_plain_rollover() -> None:
    spec = _make_spec()
    granted = _granted_tool_names(spec, "claude-sdk", labels={"omnigent.context.mode": "rollover"})
    assert "side_chat_open" not in granted


def test_granted_tool_names_includes_side_chat_open_for_superside_chat() -> None:
    spec = _make_spec()
    granted = _granted_tool_names(spec, "claude-sdk", labels=_SUPERSIDE)
    assert "side_chat_open" in granted


def test_ungranted_tool_reason_blocks_without_superside_chat_label() -> None:
    spec = _make_spec()
    assert _ungranted_tool_reason("side_chat_open", spec, "claude-sdk") is not None


def test_ungranted_tool_reason_allows_with_superside_chat_label() -> None:
    spec = _make_spec()
    reason = _ungranted_tool_reason("side_chat_open", spec, "claude-sdk", labels=_SUPERSIDE)
    assert reason is None


def test_granted_cache_distinguishes_rollover_from_superside_chat() -> None:
    """Regression: the cache key must vary on BOTH label gates, or a spec
    object reused across a rollover session and a superside-chat session
    would share (and leak) a cached grant."""
    spec = _make_spec()
    rollover_granted = _granted_tool_names(
        spec, "claude-sdk", labels={"omnigent.context.mode": "rollover"}
    )
    superside_granted = _granted_tool_names(spec, "claude-sdk", labels=_SUPERSIDE)
    assert "side_chat_open" not in rollover_granted
    assert "session_history" in rollover_granted
    assert "side_chat_open" in superside_granted
