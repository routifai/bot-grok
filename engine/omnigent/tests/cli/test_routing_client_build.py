"""Tests for how the server bootstrap assembles both routing backends.

Companion to ``test_build_routing_client.py``, which covers the individual
builders. Here the question is the PAIR: an explicit external provider with an
``llm:`` block gets the external router *and* the built-in judge, so an
off-gateway harness still routes, and ``routing_client`` stays the pair's primary.
"""

from __future__ import annotations

from contextlib import contextmanager
from typing import Any
from unittest.mock import MagicMock, patch

from omnigent.cli import _build_routing_backends
from omnigent.server.smart_routing import (
    ExternalRoutingClient,
    LLMRoutingClient,
    RoutingSettings,
)

_LLM_BLOCK: dict[str, Any] = {"model": "databricks-claude-haiku-4-5"}


def _server_llm() -> Any:
    from omnigent.spec import parse_server_llm

    return parse_server_llm(_LLM_BLOCK)


@contextmanager
def _policy_client() -> Any:
    """Stub the policy-LLM plumbing so no real credential is resolved."""
    with (
        patch(
            "omnigent.runtime.policies.builder._resolve_server_llm_connection",
            return_value=None,
        ),
        patch(
            "omnigent.runtime.policies.builder._build_policy_llm_client",
            return_value=MagicMock(),
        ),
    ):
        yield


def test_an_explicit_external_provider_plus_an_llm_block_gets_both() -> None:
    cfg = {
        "routing": {
            "provider": "external",
            "base_url": "https://host/ai-gateway/routing/v1",
            "router_name": "task_v1",
        }
    }
    with _policy_client():
        backends = _build_routing_backends(cfg, _server_llm(), RoutingSettings())
    assert isinstance(backends.external, ExternalRoutingClient)
    assert isinstance(backends.local, LLMRoutingClient)
    # The primary every legacy consumer reads is the external client.
    assert backends.any() is backends.external


def test_provider_none_configures_neither_backend() -> None:
    cfg = {"routing": {"provider": "none"}}
    with _policy_client():
        backends = _build_routing_backends(cfg, _server_llm(), RoutingSettings())
    assert (backends.external, backends.local) == (None, None)
    assert backends.any() is None


def test_an_llm_block_alone_configures_only_the_built_in_judge() -> None:
    """No ``routing:`` block means judge only."""
    with _policy_client():
        backends = _build_routing_backends({}, _server_llm(), RoutingSettings())
    assert backends.external is None
    assert isinstance(backends.local, LLMRoutingClient)
    assert backends.any() is backends.local


def test_an_unusable_config_leaves_routing_off() -> None:
    """A default (non-external, non-none) provider with no ``llm:`` block."""
    backends = _build_routing_backends({"routing": {"provider": "judge"}}, None, RoutingSettings())
    assert (backends.external, backends.local) == (None, None)
