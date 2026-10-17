"""Runner-owned background session title inference tests."""

from __future__ import annotations

import asyncio
import json
import uuid
from contextlib import asynccontextmanager
from datetime import date
from typing import Any

import httpx
import pytest

from omnigent.harness_plugins import BackgroundTitleGeneratorSpec
from omnigent.runner import create_runner_app
from omnigent.runner.background_titles import BackgroundTitleContext
from omnigent.runner.background_titles import sdk as sdk_titles
from omnigent.runner.background_titles import service as title_service
from omnigent.runner.background_titles.service import (
    BACKGROUND_TITLE_MAX_OUTPUT_TOKENS,
    CUSTOM_BACKGROUND_TITLE_MAX_OUTPUT_TOKENS,
    FOLLOW_USER_LANGUAGE_TITLE_INSTRUCTION,
    background_title_max_output_tokens,
    build_background_title_instructions,
)
from tests.runner.helpers import NullServerClient


class _FakeHarnessStream:
    def __init__(self, events: list[dict[str, Any]]) -> None:
        self.status_code = 200
        self._events = events

    async def __aenter__(self) -> _FakeHarnessStream:
        return self

    async def __aexit__(self, *args: object) -> None:
        return None

    async def aiter_lines(self):
        for event in self._events:
            yield f"data: {json.dumps(event)}"
            yield ""


class _FakeHarnessClient:
    def __init__(self) -> None:
        self.requests: list[tuple[str, dict[str, Any]]] = []

    def stream(
        self,
        method: str,
        url: str,
        *,
        json: dict[str, Any],
        timeout: float | None,
    ) -> _FakeHarnessStream:
        assert method == "POST"
        assert timeout is None
        self.requests.append((url, json))
        return _FakeHarnessStream(
            [
                {"type": "response.output_text.delta", "delta": "Debug authentication"},
                {"type": "response.output_text.delta", "delta": " timeout"},
                {"type": "response.completed"},
            ]
        )


class _FakeProcessManager:
    def __init__(self, client: _FakeHarnessClient) -> None:
        self.client = client
        self.get_client_calls: list[tuple[str, str, dict[str, str] | None]] = []
        self.released: list[str] = []

    async def get_client(
        self,
        conversation_id: str,
        harness_name: str,
        *,
        env: dict[str, str] | None = None,
    ) -> _FakeHarnessClient:
        self.get_client_calls.append((conversation_id, harness_name, env))
        return self.client

    async def release(self, conversation_id: str) -> None:
        self.released.append(conversation_id)


@asynccontextmanager
async def _runner_client(app):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://runner") as client:
        yield client


def test_custom_background_title_instructions_include_date_and_keep_guardrails() -> None:
    instructions = build_background_title_instructions(
        "Use the format mon-dd-PR-number-slug.",
        current_date=date(2026, 8, 26),
    )

    assert "The current date is 2026-08-26." in instructions
    assert "Use the format mon-dd-PR-number-slug." in instructions
    assert "same primary language as the user's message" in instructions
    assert instructions.endswith("Return only the title with no quotes or markdown.")


def test_default_background_title_follows_user_message_language() -> None:
    instructions = build_background_title_instructions(None)

    assert "same primary language as the user's message" in instructions
    assert "equally short phrase" in instructions


def test_forwarded_framework_language_rule_keeps_default_runner_prompt() -> None:
    instructions = build_background_title_instructions(FOLLOW_USER_LANGUAGE_TITLE_INSTRUCTION)

    assert instructions == build_background_title_instructions(None)
    assert instructions.count(FOLLOW_USER_LANGUAGE_TITLE_INSTRUCTION) == 1
    assert (
        background_title_max_output_tokens(FOLLOW_USER_LANGUAGE_TITLE_INSTRUCTION)
        == BACKGROUND_TITLE_MAX_OUTPUT_TOKENS
    )


def test_operator_language_override_stays_custom_after_framework_suffix() -> None:
    forwarded = f"Always use English.\n{FOLLOW_USER_LANGUAGE_TITLE_INSTRUCTION}"
    instructions = build_background_title_instructions(forwarded)

    assert "Always use English." in instructions
    assert instructions.count(FOLLOW_USER_LANGUAGE_TITLE_INSTRUCTION) == 1
    assert (
        background_title_max_output_tokens(forwarded) == CUSTOM_BACKGROUND_TITLE_MAX_OUTPUT_TOKENS
    )


@pytest.mark.parametrize(
    ("phase", "expected_action"),
    [
        ("PHASE_LLM_REQUEST", "POLICY_ACTION_ALLOW"),
        ("PHASE_TOOL_CALL", "POLICY_ACTION_DENY"),
    ],
)
@pytest.mark.asyncio
async def test_background_title_resolves_synthetic_claude_policy_gate(
    monkeypatch: pytest.MonkeyPatch,
    phase: str,
    expected_action: str,
) -> None:
    verdict_received = asyncio.Event()

    class PolicyStream(_FakeHarnessStream):
        async def aiter_lines(self):
            yield "data: " + json.dumps(
                {
                    "type": "policy_evaluation.requested",
                    "evaluation_id": "poleval_title",
                    "phase": phase,
                    "data": {},
                }
            )
            yield ""
            await verdict_received.wait()
            yield "data: " + json.dumps(
                {
                    "type": "response.output_text.delta",
                    "delta": "Debug authentication timeout",
                }
            )
            yield ""
            yield "data: " + json.dumps({"type": "response.completed"})
            yield ""

    class PolicyClient(_FakeHarnessClient):
        def __init__(self) -> None:
            super().__init__()
            self.verdicts: list[tuple[str, dict[str, Any]]] = []

        def stream(
            self,
            method: str,
            url: str,
            *,
            json: dict[str, Any],
            timeout: float | None,
        ) -> _FakeHarnessStream:
            assert method == "POST"
            assert timeout is None
            self.requests.append((url, json))
            return PolicyStream([])

        async def post(self, url: str, *, json: dict[str, Any]) -> None:
            self.verdicts.append((url, json))
            verdict_received.set()

    harness_client = PolicyClient()
    process_manager = _FakeProcessManager(harness_client)

    async def resolve_harness_config(**_kwargs: Any) -> tuple[str, None]:
        return "claude-sdk", None

    monkeypatch.setattr(
        "omnigent.runner.app._resolve_harness_config",
        resolve_harness_config,
    )
    monkeypatch.setattr(
        "omnigent.runner.background_titles.sdk.BACKGROUND_TITLE_INFERENCE_TIMEOUT_SECONDS",
        0.05,
    )
    app = create_runner_app(
        process_manager=process_manager,  # type: ignore[arg-type]
        server_client=NullServerClient(),  # type: ignore[arg-type]
    )

    async with _runner_client(app) as client:
        response = await client.post(
            "/v1/sessions/conv_test/background-title",
            json={"prompt": "please investigate the authentication timeout"},
        )

    assert response.status_code == 200
    assert response.json() == {
        "status": "generated",
        "title": "Debug authentication timeout",
    }
    [(process_key, harness, _env)] = process_manager.get_client_calls
    assert harness == "claude-sdk"
    assert harness_client.verdicts == [
        (
            f"/v1/sessions/{process_key}/events",
            {
                "type": "policy_verdict",
                "evaluation_id": "poleval_title",
                "action": expected_action,
            },
        )
    ]
    [(_url, body)] = harness_client.requests
    assert body["max_output_tokens"] == 32
    assert body["model_override"] == "haiku"


@pytest.mark.parametrize("evaluation_id", [None, ""])
@pytest.mark.asyncio
async def test_background_title_rejects_policy_gate_without_evaluation_id(
    monkeypatch: pytest.MonkeyPatch,
    evaluation_id: str | None,
) -> None:
    class InvalidPolicyClient(_FakeHarnessClient):
        def stream(
            self,
            method: str,
            url: str,
            *,
            json: dict[str, Any],
            timeout: float | None,
        ) -> _FakeHarnessStream:
            assert method == "POST"
            assert timeout is None
            self.requests.append((url, json))
            return _FakeHarnessStream(
                [
                    {
                        "type": "policy_evaluation.requested",
                        "evaluation_id": evaluation_id,
                        "phase": "PHASE_LLM_REQUEST",
                    }
                ]
            )

    harness_client = InvalidPolicyClient()
    process_manager = _FakeProcessManager(harness_client)

    async def resolve_harness_config(**_kwargs: Any) -> tuple[str, None]:
        return "claude-sdk", None

    monkeypatch.setattr(
        "omnigent.runner.app._resolve_harness_config",
        resolve_harness_config,
    )
    app = create_runner_app(
        process_manager=process_manager,  # type: ignore[arg-type]
        server_client=NullServerClient(),  # type: ignore[arg-type]
    )

    async with _runner_client(app) as client:
        response = await client.post(
            "/v1/sessions/conv_test/background-title",
            json={"prompt": "please investigate the authentication timeout"},
        )

    assert response.status_code == 502
    assert response.json() == {
        "error": "title_harness_failed",
        "detail": "Harness requested policy evaluation without an id.",
    }
    # The economy-tier attempt fails the same policy check, then the
    # session-model retry hits it again; both synthetic processes are released.
    first_key, second_key = process_manager.released
    assert first_key != second_key
    for process_key in process_manager.released:
        assert uuid.UUID(process_key).hex == process_key
    [(_, first_body), (_, second_body)] = harness_client.requests
    assert first_body["model_override"] == "haiku"
    assert "model_override" not in second_body


@pytest.mark.asyncio
async def test_background_title_dispatches_any_registered_harness(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    harness_client = _FakeHarnessClient()
    process_manager = _FakeProcessManager(harness_client)
    captured: list[BackgroundTitleContext] = []

    async def resolve_harness_config(**_kwargs: Any) -> tuple[str, dict[str, str]]:
        return "community-example", {"EXAMPLE_MODEL": "example-model"}

    async def generate_title(context: BackgroundTitleContext) -> str:
        captured.append(context)
        return "Review generic dispatch"

    monkeypatch.setattr(
        "omnigent.runner.app._resolve_harness_config",
        resolve_harness_config,
    )
    monkeypatch.setattr(
        "omnigent.runner.background_titles.service.background_title_generators",
        lambda: {
            "community-example": BackgroundTitleGeneratorSpec(
                "example_plugin.background_titles:generate"
            )
        },
    )
    monkeypatch.setattr(
        "omnigent.runner.background_titles.service.load_object",
        lambda _path: generate_title,
    )
    app = create_runner_app(
        process_manager=process_manager,  # type: ignore[arg-type]
        server_client=NullServerClient(),  # type: ignore[arg-type]
    )

    async with _runner_client(app) as client:
        response = await client.post(
            "/v1/sessions/conv_test/background-title",
            json={
                "prompt": "please review the generic dispatch path",
                "model_override": "example-model",
            },
        )

    assert response.status_code == 200
    assert response.json() == {
        "status": "generated",
        "title": "Review generic dispatch",
    }
    [context] = captured
    assert context.harness == "community-example"
    assert context.spawn_env == {"EXAMPLE_MODEL": "example-model"}
    assert context.model_override == "example-model"
    assert process_manager.get_client_calls == []
    assert process_manager.released == []


def _register_fake_title_generator(
    monkeypatch: pytest.MonkeyPatch,
    harness: str,
    generator: Any,
) -> None:
    monkeypatch.setattr(
        "omnigent.runner.background_titles.service.background_title_generators",
        lambda: {harness: BackgroundTitleGeneratorSpec("example:generate")},
    )
    monkeypatch.setattr(
        "omnigent.runner.background_titles.service.load_object",
        lambda _path: generator,
    )


def _title_context(harness: str, **overrides: Any) -> BackgroundTitleContext:
    kwargs: dict[str, Any] = {
        "prompt": "please investigate the authentication timeout",
        "harness": harness,
        "spawn_env": {},
        "process_manager": None,
    }
    kwargs.update(overrides)
    return BackgroundTitleContext(**kwargs)


@pytest.mark.asyncio
async def test_background_title_dispatch_pins_economy_model_for_mapped_harness(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    contexts: list[BackgroundTitleContext] = []

    async def generate_title(context: BackgroundTitleContext) -> str:
        contexts.append(context)
        return "Debug authentication timeout"

    _register_fake_title_generator(monkeypatch, "claude-sdk", generate_title)

    title = await title_service.generate_background_title(
        _title_context("claude-sdk", model_override="gpt-5.4-mini")
    )

    assert title == "Debug authentication timeout"
    [context] = contexts
    assert context.title_model == "haiku"
    assert context.model_override == "gpt-5.4-mini"


@pytest.mark.asyncio
async def test_background_title_dispatch_retries_with_session_model_after_economy_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    attempted_models: list[str | None] = []

    async def generate_title(context: BackgroundTitleContext) -> str:
        attempted_models.append(context.title_model)
        if context.title_model is not None:
            raise RuntimeError("provider does not serve the economy model")
        return "Debug authentication timeout"

    _register_fake_title_generator(monkeypatch, "claude-sdk", generate_title)

    title = await title_service.generate_background_title(_title_context("claude-sdk"))

    assert title == "Debug authentication timeout"
    assert attempted_models == ["haiku", None]


@pytest.mark.asyncio
async def test_background_title_dispatch_leaves_unmapped_harness_on_session_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    contexts: list[BackgroundTitleContext] = []

    async def generate_title(context: BackgroundTitleContext) -> str:
        contexts.append(context)
        return "Debug authentication timeout"

    _register_fake_title_generator(monkeypatch, "pi", generate_title)

    title = await title_service.generate_background_title(_title_context("pi"))

    assert title == "Debug authentication timeout"
    [context] = contexts
    assert context.title_model is None


@pytest.mark.asyncio
async def test_sdk_title_event_carries_title_model_as_model_override() -> None:
    harness_client = _FakeHarnessClient()
    process_manager = _FakeProcessManager(harness_client)

    title = await sdk_titles.generate_background_title(
        BackgroundTitleContext(
            prompt="please investigate the authentication timeout",
            harness="claude-sdk",
            spawn_env={},
            process_manager=process_manager,  # type: ignore[arg-type]
            title_model="haiku",
        )
    )

    assert title == "Debug authentication timeout"
    [(_url, body)] = harness_client.requests
    assert body["model_override"] == "haiku"
    assert body["model"] == "session-title"


@pytest.mark.asyncio
async def test_background_title_skips_unsupported_harness_without_spawning(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    harness_client = _FakeHarnessClient()
    process_manager = _FakeProcessManager(harness_client)

    async def resolve_harness_config(**kwargs: Any) -> tuple[str, None]:
        del kwargs
        return "pi", None

    monkeypatch.setattr(
        "omnigent.runner.app._resolve_harness_config",
        resolve_harness_config,
    )
    app = create_runner_app(
        process_manager=process_manager,  # type: ignore[arg-type]
        server_client=NullServerClient(),  # type: ignore[arg-type]
    )

    async with _runner_client(app) as client:
        response = await client.post(
            "/v1/sessions/conv_test/background-title",
            json={"prompt": "please investigate the authentication timeout"},
        )

    assert response.status_code == 200
    assert response.json() == {"status": "unsupported", "title": None}
    assert process_manager.get_client_calls == []
    assert process_manager.released == []
    assert harness_client.requests == []


@pytest.mark.asyncio
async def test_background_title_surfaces_harness_failure_and_releases_process(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FailedClient(_FakeHarnessClient):
        def stream(
            self,
            method: str,
            url: str,
            *,
            json: dict[str, Any],
            timeout: float | None,
        ) -> _FakeHarnessStream:
            assert method == "POST"
            assert timeout is None
            self.requests.append((url, json))
            return _FakeHarnessStream(
                [
                    {
                        "type": "response.failed",
                        "response": {
                            "status": "failed",
                            "error": {"message": "Harness authentication expired."},
                        },
                    }
                ]
            )

    harness_client = FailedClient()
    process_manager = _FakeProcessManager(harness_client)

    async def resolve_harness_config(**_kwargs: Any) -> tuple[str, None]:
        return "claude-sdk", None

    monkeypatch.setattr(
        "omnigent.runner.app._resolve_harness_config",
        resolve_harness_config,
    )
    app = create_runner_app(
        process_manager=process_manager,  # type: ignore[arg-type]
        server_client=NullServerClient(),  # type: ignore[arg-type]
    )

    async with _runner_client(app) as client:
        response = await client.post(
            "/v1/sessions/conv_test/background-title",
            json={"prompt": "please investigate the authentication timeout"},
        )

    assert response.status_code == 502
    assert response.json() == {
        "error": "title_harness_failed",
        "detail": "Harness authentication expired.",
    }
    # The economy-tier attempt fails, then the session-model retry fails
    # identically; both synthetic processes are released.
    first_key, second_key = process_manager.released
    assert first_key != second_key
    for process_key in process_manager.released:
        assert uuid.UUID(process_key).hex == process_key
    [(_, first_body), (_, second_body)] = harness_client.requests
    assert first_body["model_override"] == "haiku"
    assert "model_override" not in second_body


@pytest.mark.asyncio
async def test_background_title_timeout_releases_process(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class HangingStream(_FakeHarnessStream):
        async def aiter_lines(self):
            await asyncio.Event().wait()
            yield ""

    class HangingClient(_FakeHarnessClient):
        def stream(
            self,
            method: str,
            url: str,
            *,
            json: dict[str, Any],
            timeout: float | None,
        ) -> _FakeHarnessStream:
            assert method == "POST"
            assert timeout is None
            self.requests.append((url, json))
            return HangingStream([])

    harness_client = HangingClient()
    process_manager = _FakeProcessManager(harness_client)

    async def resolve_harness_config(**_kwargs: Any) -> tuple[str, None]:
        return "claude-sdk", None

    monkeypatch.setattr(
        "omnigent.runner.app._resolve_harness_config",
        resolve_harness_config,
    )
    monkeypatch.setattr(
        "omnigent.runner.background_titles.sdk.BACKGROUND_TITLE_INFERENCE_TIMEOUT_SECONDS",
        0.01,
    )
    app = create_runner_app(
        process_manager=process_manager,  # type: ignore[arg-type]
        server_client=NullServerClient(),  # type: ignore[arg-type]
    )

    async with _runner_client(app) as client:
        response = await client.post(
            "/v1/sessions/conv_test/background-title",
            json={"prompt": "please investigate the authentication timeout"},
        )

    assert response.status_code == 504
    assert response.json()["error"] == "title_harness_timeout"
    [process_key] = process_manager.released
    assert uuid.UUID(process_key).hex == process_key


def test_final_text_block_keeps_only_last_block() -> None:
    from omnigent.runner.background_titles.sdk import final_text_block

    glued = "Context-Free Title Request\n\nUnclear Question About Something"
    assert final_text_block(glued) == "Unclear Question About Something"
    assert final_text_block("Debug authentication timeout") == "Debug authentication timeout"
    assert final_text_block(" \n\n ") is None
