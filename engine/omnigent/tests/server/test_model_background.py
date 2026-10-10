"""Background work's model: the organization's fast pick over the owner's connection."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest
import yaml

from omnigent.llms.background import (
    provider_connection,
    register_background_llm,
    resolve_background_llm,
)
from omnigent.onboarding.provider_config import load_providers
from omnigent.server.managed_hosts import parse_sandbox_config
from omnigent.superchat.models.background import BackgroundModels, background_harness

from .test_byok_pi import _hosted_state, _service

DEFAULT_TEMPLATE = Path(__file__).resolve().parents[4] / "infra/railway/engine.config.yaml.tmpl"


def _with_picks(state: SimpleNamespace, picks: dict) -> SimpleNamespace:
    state.model_org_overlay = SimpleNamespace(get=lambda: picks)
    return state


def test_the_harness_is_the_one_with_a_fast_pick_else_a_default_else_the_first() -> None:
    bound = ["claude-sdk", "pi"]
    assert background_harness(bound, {}) == "claude-sdk"
    assert background_harness(bound, {"pi": {"default": "x"}}) == "pi"
    assert background_harness(bound, {"pi": {"default": "x"}, "claude-sdk": {"fast": "y"}}) == (
        "claude-sdk"
    )
    assert background_harness([], {}) is None


@pytest.mark.asyncio
async def test_the_fast_pick_runs_on_the_owners_anthropic_key() -> None:
    state = _with_picks(
        _hosted_state({"alice": ("anthropic", "sk-ant-x")}),
        {"claude-sdk": {"fast": "claude-haiku-4-5"}},
    )
    resolved = await BackgroundModels(state).resolve("alice")
    assert resolved == (
        "anthropic/claude-haiku-4-5",
        {"api_key": "sk-ant-x", "base_url": "https://api.anthropic.com/v1"},
    )


@pytest.mark.asyncio
async def test_nothing_picked_uses_the_connections_own_first_model() -> None:
    state = _with_picks(_hosted_state({"alice": ("anthropic", "sk-ant-x")}), {})
    model, _ = await BackgroundModels(state).resolve("alice") or ("", None)
    assert model == "anthropic/claude-sonnet-5-5"


@pytest.mark.asyncio
async def test_a_bearer_upstream_is_called_over_chat_completions() -> None:
    state = _with_picks(_hosted_state({"bob": ("openrouter", "sk-or-x")}), {})
    resolved = await BackgroundModels(state).resolve("bob")
    assert resolved == (
        "openai_compatible/deepseek/deepseek-chat",
        {"api_key": "sk-or-x", "base_url": "https://openrouter.ai/api/v1"},
    )


@pytest.mark.asyncio
async def test_no_key_means_nothing_to_call_not_an_error() -> None:
    state = _with_picks(_hosted_state({}), {"claude-sdk": {"fast": "claude-haiku-4-5"}})
    assert await BackgroundModels(state).resolve("carol") is None


@pytest.mark.asyncio
async def test_an_operator_gateway_is_called_through_its_own_family(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-operator")
    raw = yaml.safe_load(
        DEFAULT_TEMPLATE.read_text().replace("__ENGINE_PUBLIC_URL__", "https://eng.example")
    )
    deployment = parse_sandbox_config(raw["sandbox"])
    state = SimpleNamespace(
        sandbox_config=deployment,
        databricks_store=None,
        databricks_client=None,
        model_connection_store=None,
        model_org_overlay=SimpleNamespace(
            get=lambda: {"claude-sdk": {"fast": "claude-haiku-4-5"}}
        ),
    )
    state.inference_catalog = _service(state)
    resolved = await BackgroundModels(state).resolve(None)
    assert resolved == (
        "anthropic/claude-haiku-4-5",
        {"base_url": "https://api.anthropic.com/v1", "api_key": "sk-ant-operator"},
    )


def test_provider_connection_takes_the_wire_from_the_provider(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("GW_KEY", "k")
    providers = load_providers(
        {
            "providers": {
                "messages": {
                    "kind": "gateway",
                    "anthropic": {"base_url": "https://gw.example", "api_key_ref": "env:GW_KEY"},
                },
                "chat": {
                    "kind": "gateway",
                    "openai": {
                        "base_url": "https://gw.example/v1",
                        "api_key_ref": "env:GW_KEY",
                        "wire_api": "chat",
                    },
                },
            }
        }
    )
    assert provider_connection(providers["messages"]) == (
        "anthropic",
        {"base_url": "https://gw.example/v1", "api_key": "k"},
    )
    assert provider_connection(providers["chat"]) == (
        "openai_compatible",
        {"base_url": "https://gw.example/v1", "api_key": "k"},
    )


@pytest.mark.asyncio
async def test_the_registered_resolver_answers_when_no_server_llm_is_configured() -> None:
    async def resolver(owner: str | None) -> tuple[str, dict[str, str] | None]:
        return f"anthropic/fast-for-{owner}", None

    register_background_llm(resolver)
    try:
        assert await resolve_background_llm("alice") == ("anthropic/fast-for-alice", None)
    finally:
        register_background_llm(None)
    assert await resolve_background_llm("alice") is None
