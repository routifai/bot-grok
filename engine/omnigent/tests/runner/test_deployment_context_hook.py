"""Tests for the runner's per-turn deployment-context hook wiring.

``omnigent.runner.app._append_deployment_context`` is the seam both turn
paths (background dispatch and direct-stream) call to append the
``OMNIGENT_CONTEXT_PROVIDER_URL`` hook's result to a turn's composed
instructions. See ``omnigent/runtime/context_provider.py`` for the fetch
contract itself (covered by ``tests/runtime/test_context_provider.py``).
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from omnigent.runner.app import _append_deployment_context


@pytest.fixture(autouse=True)
def _no_real_client():
    # server_client is only forwarded to the (mocked) labels lookup below —
    # never used to make a real HTTP call in these tests.
    return object()


async def test_unconfigured_provider_is_a_complete_no_op() -> None:
    """Unset provider: instructions pass through unchanged, no labels fetch."""
    with (
        patch("omnigent.runner.app.context_provider_configured", return_value=False),
        patch("omnigent.runner.app._session_labels_for_runner_spawn") as labels_mock,
    ):
        result = await _append_deployment_context(
            "agent instructions",
            server_client=object(),
            session_id="s1",
            agent_name="agent",
            harness_name="pi",
            turn_input="hi",
        )
    assert result == "agent instructions"
    labels_mock.assert_not_called()


async def test_unconfigured_provider_preserves_none_instructions() -> None:
    """A ``None`` base (gated harness, no authored text) stays ``None``."""
    with patch("omnigent.runner.app.context_provider_configured", return_value=False):
        result = await _append_deployment_context(
            None,
            server_client=object(),
            session_id="s1",
            agent_name="agent",
            harness_name="opencode-native",
            turn_input="hi",
        )
    assert result is None


async def test_configured_provider_appends_block_after_composed_instructions() -> None:
    with (
        patch("omnigent.runner.app.context_provider_configured", return_value=True),
        patch(
            "omnigent.runner.app._session_labels_for_runner_spawn",
            new=AsyncMock(return_value={"team": "growth"}),
        ) as labels_mock,
        patch(
            "omnigent.runner.app.fetch_deployment_context",
            new=AsyncMock(
                return_value="\n\n<deployment_context>\nbe careful\n</deployment_context>"
            ),
        ) as fetch_mock,
    ):
        result = await _append_deployment_context(
            "agent instructions",
            server_client="the-client",
            session_id="s2",
            agent_name="research-agent",
            harness_name="pi",
            turn_input="what's up",
        )
    assert result == (
        "agent instructions\n\n<deployment_context>\nbe careful\n</deployment_context>"
    )
    labels_mock.assert_awaited_once_with(server_client="the-client", session_id="s2")
    fetch_mock.assert_awaited_once_with(
        session_id="s2",
        agent_name="research-agent",
        harness="pi",
        user_id=None,
        labels={"team": "growth"},
        turn_input="what's up",
    )


async def test_configured_provider_with_none_base_yields_bare_block() -> None:
    with (
        patch("omnigent.runner.app.context_provider_configured", return_value=True),
        patch(
            "omnigent.runner.app._session_labels_for_runner_spawn",
            new=AsyncMock(return_value={}),
        ),
        patch(
            "omnigent.runner.app.fetch_deployment_context",
            new=AsyncMock(return_value="\n\n<deployment_context>\nhello\n</deployment_context>"),
        ),
    ):
        result = await _append_deployment_context(
            None,
            server_client=object(),
            session_id="s3",
            agent_name=None,
            harness_name="codex",
            turn_input="",
        )
    assert result == "\n\n<deployment_context>\nhello\n</deployment_context>"


async def test_configured_provider_empty_block_leaves_instructions_unchanged() -> None:
    """Provider unreachable/empty for this turn: base instructions untouched."""
    with (
        patch("omnigent.runner.app.context_provider_configured", return_value=True),
        patch(
            "omnigent.runner.app._session_labels_for_runner_spawn",
            new=AsyncMock(return_value={}),
        ),
        patch(
            "omnigent.runner.app.fetch_deployment_context",
            new=AsyncMock(return_value=""),
        ),
    ):
        result = await _append_deployment_context(
            "agent instructions",
            server_client=object(),
            session_id="s4",
            agent_name="agent",
            harness_name="pi",
            turn_input="",
        )
    assert result == "agent instructions"
