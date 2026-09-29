"""Tests for the runner's per-turn deployment-context hook wiring.

``omnigent.runner.app._append_deployment_context`` is the seam both turn
paths (background dispatch and direct-stream) call to append the
deployment-context hook's result to a turn's composed instructions. Unlike
before d1b3a94's follow-up, the runner never calls the
``OMNIGENT_CONTEXT_PROVIDER_URL`` hook (or reads its secret) itself — a
runner can be a user's own laptop (``omnigent host``) and must never hold
the provider secret. Instead it POSTs to the server's
``/sessions/{id}/deployment-context`` callback via ``server_client``. See
``omnigent/runtime/context_provider.py`` (covered by
``tests/runtime/test_context_provider.py``) for the fetch contract the
server-side endpoint itself calls.
"""

from __future__ import annotations

import httpx
import pytest
import respx

from omnigent.runner.app import (
    _append_deployment_context,
    _deployment_context_call_warned,
    _forget_deployment_context_warning,
)

_SERVER_URL = "https://server.test"


@pytest.fixture(autouse=True)
def _clean_warned_sessions():
    """Isolate the warn-once-per-session bookkeeping across tests."""
    _deployment_context_call_warned.clear()
    yield
    _deployment_context_call_warned.clear()


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(base_url=_SERVER_URL)


async def test_provider_configured_false_is_a_complete_no_op() -> None:
    """``provider_configured=False``: no network call at all, unchanged text."""
    async with _client() as client, respx.mock:
        # No route registered — any HTTP call would raise inside respx.mock.
        result = await _append_deployment_context(
            "agent instructions",
            server_client=client,
            session_id="s1",
            agent_name="agent",
            harness_name="pi",
            turn_input="hi",
            provider_configured=False,
        )
    assert result == "agent instructions"


async def test_provider_configured_false_preserves_none_instructions() -> None:
    async with _client() as client, respx.mock:
        result = await _append_deployment_context(
            None,
            server_client=client,
            session_id="s1",
            agent_name="agent",
            harness_name="opencode-native",
            turn_input="hi",
            provider_configured=False,
        )
    assert result is None


async def test_unknown_provider_state_still_calls_the_endpoint() -> None:
    """``provider_configured=None`` (no session-init snapshot yet): attempt the call."""
    async with _client() as client, respx.mock:
        route = respx.post(f"{_SERVER_URL}/v1/sessions/s1/deployment-context").mock(
            return_value=httpx.Response(200, json={"block": ""})
        )
        await _append_deployment_context(
            "agent instructions",
            server_client=client,
            session_id="s1",
            agent_name="agent",
            harness_name="pi",
            turn_input="hi",
            provider_configured=None,
        )
    assert route.called


async def test_configured_provider_appends_block_after_composed_instructions() -> None:
    captured: dict[str, object] = {}

    def _responder(request: httpx.Request) -> httpx.Response:
        import json

        captured["body"] = json.loads(request.content)
        return httpx.Response(
            200, json={"block": "\n\n<deployment_context>\nbe careful\n</deployment_context>"}
        )

    async with _client() as client, respx.mock:
        respx.post(f"{_SERVER_URL}/v1/sessions/s2/deployment-context").mock(side_effect=_responder)
        result = await _append_deployment_context(
            "agent instructions",
            server_client=client,
            session_id="s2",
            agent_name="research-agent",
            harness_name="pi",
            turn_input="what's up",
            provider_configured=True,
        )

    assert result == (
        "agent instructions\n\n<deployment_context>\nbe careful\n</deployment_context>"
    )
    assert captured["body"] == {
        "agent_name": "research-agent",
        "harness": "pi",
        "turn_input": "what's up",
    }


async def test_configured_provider_with_none_base_yields_bare_block() -> None:
    async with _client() as client, respx.mock:
        respx.post(f"{_SERVER_URL}/v1/sessions/s3/deployment-context").mock(
            return_value=httpx.Response(
                200, json={"block": "\n\n<deployment_context>\nhello\n</deployment_context>"}
            )
        )
        result = await _append_deployment_context(
            None,
            server_client=client,
            session_id="s3",
            agent_name=None,
            harness_name="codex",
            turn_input="",
            provider_configured=True,
        )
    assert result == "\n\n<deployment_context>\nhello\n</deployment_context>"


async def test_empty_block_leaves_instructions_unchanged() -> None:
    async with _client() as client, respx.mock:
        respx.post(f"{_SERVER_URL}/v1/sessions/s4/deployment-context").mock(
            return_value=httpx.Response(200, json={"block": ""})
        )
        result = await _append_deployment_context(
            "agent instructions",
            server_client=client,
            session_id="s4",
            agent_name="agent",
            harness_name="pi",
            turn_input="",
            provider_configured=True,
        )
    assert result == "agent instructions"


# ── fail-open on timeout / error / non-200 ───────────────────────────


async def test_timeout_fails_open() -> None:
    async with _client() as client, respx.mock:
        respx.post(f"{_SERVER_URL}/v1/sessions/s5/deployment-context").mock(
            side_effect=httpx.TimeoutException("slow")
        )
        result = await _append_deployment_context(
            "agent instructions",
            server_client=client,
            session_id="s5",
            agent_name="agent",
            harness_name="pi",
            turn_input="",
            provider_configured=True,
        )
    assert result == "agent instructions"


async def test_non_200_fails_open() -> None:
    async with _client() as client, respx.mock:
        respx.post(f"{_SERVER_URL}/v1/sessions/s6/deployment-context").mock(
            return_value=httpx.Response(500)
        )
        result = await _append_deployment_context(
            "agent instructions",
            server_client=client,
            session_id="s6",
            agent_name="agent",
            harness_name="pi",
            turn_input="",
            provider_configured=True,
        )
    assert result == "agent instructions"


async def test_malformed_json_response_fails_open() -> None:
    async with _client() as client, respx.mock:
        respx.post(f"{_SERVER_URL}/v1/sessions/s7/deployment-context").mock(
            return_value=httpx.Response(200, text="not json")
        )
        result = await _append_deployment_context(
            "agent instructions",
            server_client=client,
            session_id="s7",
            agent_name="agent",
            harness_name="pi",
            turn_input="",
            provider_configured=True,
        )
    assert result == "agent instructions"


async def test_connection_error_fails_open() -> None:
    async with _client() as client, respx.mock:
        respx.post(f"{_SERVER_URL}/v1/sessions/s8/deployment-context").mock(
            side_effect=httpx.ConnectError("refused")
        )
        result = await _append_deployment_context(
            "agent instructions",
            server_client=client,
            session_id="s8",
            agent_name="agent",
            harness_name="pi",
            turn_input="",
            provider_configured=True,
        )
    assert result == "agent instructions"


async def test_failure_warns_once_per_session(caplog: pytest.LogCaptureFixture) -> None:
    async with _client() as client, respx.mock:
        respx.post(f"{_SERVER_URL}/v1/sessions/repeat-session/deployment-context").mock(
            return_value=httpx.Response(500)
        )
        with caplog.at_level("WARNING"):
            for _ in range(3):
                await _append_deployment_context(
                    "instructions",
                    server_client=client,
                    session_id="repeat-session",
                    agent_name="a",
                    harness_name="codex",
                    turn_input="",
                    provider_configured=True,
                )
    warnings = [r for r in caplog.records if r.levelname == "WARNING"]
    assert len(warnings) == 1

    _forget_deployment_context_warning("repeat-session")
    async with _client() as client, respx.mock:
        respx.post(f"{_SERVER_URL}/v1/sessions/repeat-session/deployment-context").mock(
            return_value=httpx.Response(500)
        )
        with caplog.at_level("WARNING"):
            await _append_deployment_context(
                "instructions",
                server_client=client,
                session_id="repeat-session",
                agent_name="a",
                harness_name="codex",
                turn_input="",
                provider_configured=True,
            )
    warnings_after_forget = [
        r
        for r in caplog.records
        if r.levelname == "WARNING" and "repeat-session" in r.getMessage()
    ]
    assert len(warnings_after_forget) == 2  # the original + the one after forget


# ── runner never reads the provider secret ────────────────────────────


def test_runner_app_module_does_not_reference_provider_secret_env_var() -> None:
    """The runner process must never read ``OMNIGENT_CONTEXT_PROVIDER_SECRET``.

    Only the server (``omnigent/server/routes/sessions/routes_core.py``) may
    call the provider hook now — a local (``omnigent host``) runner cannot be
    trusted with the secret. Source-scans the runner's app module (skipping
    the human-readable module docstring, which names the env var only in
    prose explaining *why* the runner doesn't read it) rather than
    monkeypatching os.environ, so the assertion holds even if some future
    change re-introduces the import without calling it.
    """
    import ast
    import inspect

    import omnigent.runner.app as app_module

    tree = ast.parse(inspect.getsource(app_module))
    module_docstring = ast.get_docstring(tree) or ""
    source_without_module_docstring = inspect.getsource(app_module).replace(
        module_docstring, "", 1
    )
    assert "OMNIGENT_CONTEXT_PROVIDER_SECRET" not in source_without_module_docstring
