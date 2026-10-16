"""Regression guards: every built-in native harness must be wired into the
runner's terminal dispatch.

A native harness absent from the terminal lock dispatch raised ``KeyError`` mid
terminal-ensure (surfaced as "malformed runner response (HTTP 500)"). This pins
it so a future built-in native harness that is not fully wired fails a test
rather than a user.

The lock-coverage guard is scoped to the BUILT-IN native providers, not the
merged registry: a community-contributed native harness wires its own launcher
and must not be forced into the built-in dispatch.
"""

from __future__ import annotations

import pytest

from omnigent.harness_plugins import _BUILTIN_NATIVE_PROVIDERS
from omnigent.runner.app import _require_full_native_lock_coverage

# Built-in native harnesses are dispatched by ``agent.key`` (e.g. "claude").
_BUILTIN_NATIVE_KEYS = frozenset(provider.key for provider in _BUILTIN_NATIVE_PROVIDERS)


def _full_dispatch() -> dict[str, dict]:
    return {key: {} for key in _BUILTIN_NATIVE_KEYS}


def test_full_lock_dispatch_passes() -> None:
    dispatch = _full_dispatch()
    assert _require_full_native_lock_coverage(dispatch) is dispatch


@pytest.mark.parametrize("missing", sorted(_BUILTIN_NATIVE_KEYS))
def test_missing_harness_from_lock_dispatch_raises(missing: str) -> None:
    dispatch = _full_dispatch()
    del dispatch[missing]
    with pytest.raises(RuntimeError, match=missing):
        _require_full_native_lock_coverage(dispatch)


def test_extra_community_key_does_not_trip_the_guard() -> None:
    # A community-contributed native agent (present in the merged registry but
    # not a built-in provider) must not force the built-in dispatch to cover it.
    dispatch = _full_dispatch()
    dispatch["some-community-harness"] = {}
    assert _require_full_native_lock_coverage(dispatch) is dispatch


def test_native_terminal_roles_drive_status() -> None:
    # Harnesses without a status-posting forwarder rely on the PTY watcher, so
    # their terminal roles must be in the status-emitting set; without it the
    # web "Working..." badge never clears.
    from omnigent.runner.resource_registry import (
        _STATUS_EMITTING_TERMINAL_ROLES,
        CLAUDE_NATIVE_TERMINAL_ROLE,
        PI_NATIVE_TERMINAL_ROLE,
    )

    assert CLAUDE_NATIVE_TERMINAL_ROLE in _STATUS_EMITTING_TERMINAL_ROLES
    assert PI_NATIVE_TERMINAL_ROLE in _STATUS_EMITTING_TERMINAL_ROLES


@pytest.mark.parametrize("key", sorted(_BUILTIN_NATIVE_KEYS))
def test_every_native_terminal_role_logs_input_ready(key: str) -> None:
    # The terminal watcher emits ``native_input_ready`` for whatever probe its
    # terminal role resolves to, so every built-in harness must launch with a
    # role that names it and resolves a probe; otherwise the event is silently
    # never logged.
    from omnigent.harness_plugins import native_agents
    from omnigent.runner import resource_registry

    agent = next(agent for agent in native_agents() if agent.key == key)
    roles = {
        value
        for name, value in vars(resource_registry).items()
        if name.endswith("_NATIVE_TERMINAL_ROLE")
    }
    assert agent.harness in roles, f"no *_NATIVE_TERMINAL_ROLE for {agent.harness}"
    assert callable(resource_registry._native_input_ready_probe(agent.harness))
