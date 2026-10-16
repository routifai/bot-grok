from __future__ import annotations

import pytest

from omnigent.inner.claude_sdk_executor import ClaudeSDKExecutor
from omnigent.inner.codex_executor import CodexExecutor
from omnigent.inner.executor import ExecutorConfig, ExecutorError, TurnComplete
from omnigent.llms.adapters.anthropic import _effort_to_budget
from omnigent.llms.errors import PermanentLLMError


@pytest.mark.parametrize("effort", ["none", "minimal"])
def test_anthropic_effort_rejects_openai_only_values(effort: str) -> None:
    with pytest.raises(PermanentLLMError, match="not supported by Anthropic"):
        _effort_to_budget(effort, 10000)


@pytest.mark.asyncio
async def test_claude_sdk_rejects_none_before_sdk_call() -> None:
    executor = ClaudeSDKExecutor(gateway=False)
    events = [
        e
        async for e in executor.run_turn(
            messages=[{"role": "user", "content": "hi"}],
            tools=[],
            system_prompt="",
            config=ExecutorConfig(extra={"reasoning_effort": "none"}),
        )
    ]
    assert any(
        isinstance(e, ExecutorError) and "not supported by Claude" in e.message for e in events
    )


@pytest.mark.asyncio
async def test_codex_coerces_max_to_xhigh() -> None:
    """The deprecated ``max`` alias is coerced to ``xhigh`` for codex.

    codex's ladder tops out at ``xhigh`` (no ``max``); ``EFFORT_ALIASES``
    coerces the deprecated value rather than rejecting it. The app-session
    factory is stubbed so the turn never spawns a real codex process — it
    only needs to record the ``reasoning_effort`` it was started with.
    """
    calls: list[dict] = []

    class _FakeAppSession:
        async def run_turn(self, **kwargs):
            calls.append(kwargs)
            yield TurnComplete(response="done")

        async def close(self) -> None:
            return None

    executor = CodexExecutor(
        codex_path="/bin/echo",
        app_session_factory=lambda **kwargs: _FakeAppSession(),
    )
    events = [
        e
        async for e in executor.run_turn(
            messages=[{"role": "user", "content": "hi"}],
            tools=[],
            system_prompt="",
            config=ExecutorConfig(model="test-model", extra={"reasoning_effort": "max"}),
        )
    ]
    assert not any(isinstance(e, ExecutorError) for e in events)
    assert calls[0]["reasoning_effort"] == "xhigh"
