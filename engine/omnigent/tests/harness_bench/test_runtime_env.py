"""Unit tests for the bench env resolver (ambient gateway credentials only).

Network-free: these assert the layering (ambient ``OPENAI_*`` wins, no creds
skips, own_auth harnesses never need the gateway) without touching a gateway.
"""

from __future__ import annotations

import pytest

from tests.harness_bench.runtime_env import (
    BenchRuntimeEnv,
    bench_creds_skip_reason,
    resolve_bench_env,
)


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Start each test from a known env: no ambient OPENAI_*."""
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_BASE_URL", raising=False)


def _set_ambient(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENAI_BASE_URL", "https://ambient.example.com/v1")
    monkeypatch.setenv("OPENAI_API_KEY", "ambient-key")


def test_ambient_openai_is_used(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_ambient(monkeypatch)
    env = resolve_bench_env(None)
    assert isinstance(env, BenchRuntimeEnv)
    assert env.base_env["OPENAI_API_KEY"] == "ambient-key"
    assert env.base_env["OPENAI_BASE_URL"] == "https://ambient.example.com/v1"
    assert env.db_profile is None


def test_skip_reason_none_when_ambient(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_ambient(monkeypatch)
    assert bench_creds_skip_reason(None) is None


def test_skip_reason_when_no_creds_anywhere() -> None:
    reason = bench_creds_skip_reason(None)
    assert reason is not None
    assert "OPENAI_API_KEY" in reason


def test_skip_reason_none_when_gateway_not_required() -> None:
    """An own_auth native never skips for missing gateway creds — its model
    auth is self-contained, so no OpenAI credential is needed."""
    assert bench_creds_skip_reason(None, require_gateway=False) is None


def test_resolve_env_tolerates_missing_creds_when_gateway_optional() -> None:
    """With ``require_gateway=False`` and no ambient creds, the env is built
    without ``OPENAI_*`` instead of raising — the server boots and an own_auth
    native drives its own model."""
    env = resolve_bench_env(None, require_gateway=False)
    assert isinstance(env, BenchRuntimeEnv)
    assert "OPENAI_API_KEY" not in env.base_env
    assert "OPENAI_BASE_URL" not in env.base_env


def test_resolve_env_still_raises_when_gateway_required() -> None:
    """The default (``require_gateway=True``) still fails loud on no creds, so
    omnigent-credential harnesses skip cleanly rather than boot keyless."""
    with pytest.raises(OSError):
        resolve_bench_env(None)


def test_resolve_env_uses_ambient_even_if_optional(monkeypatch: pytest.MonkeyPatch) -> None:
    """``require_gateway=False`` still uses ambient creds when they exist, so a
    configured contributor gets the server's incidental model too."""
    _set_ambient(monkeypatch)
    env = resolve_bench_env(None, require_gateway=False)
    assert env.base_env["OPENAI_API_KEY"] == "ambient-key"
    assert env.base_env["OPENAI_BASE_URL"] == "https://ambient.example.com/v1"
