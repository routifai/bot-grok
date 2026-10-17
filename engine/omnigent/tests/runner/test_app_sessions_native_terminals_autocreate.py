"""Tests for native terminal auto-creation across supported harnesses."""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

from omnigent.inner.datamodel import OSEnvSandboxSpec, OSEnvSpec
from omnigent.runner import app as runner_app
from omnigent.runner.repl_terminal import _agent_os_env_from_spec, publish_terminal_pending
from omnigent.runner.spec_entries import ResolvedSpec
from omnigent.spec.types import AgentSpec, ExecutorSpec


def _load_claude_invocation_settings(args: list[str]) -> dict[str, Any]:
    settings_path = Path(args[args.index("--settings") + 1])
    return json.loads(settings_path.read_text(encoding="utf-8"))


def test_agent_os_env_from_spec_unwraps_resolved_and_handles_none() -> None:
    """
    ``_agent_os_env_from_spec`` reads ``os_env`` through the resolved wrapper.

    The auto-create terminals receive either a bare ``AgentSpec`` or a
    ``ResolvedSpec`` wrapping one (the codex path passes ``ResolvedSpec``).
    The helper must unwrap the latter and return the inner ``os_env``, and
    return ``None`` when there is no spec — so the launch falls back to the
    platform default only when there is genuinely no agent policy to honour.
    """

    os_env = OSEnvSpec(type="caller_process", cwd=".", sandbox=OSEnvSandboxSpec(type="none"))
    bare = AgentSpec(
        spec_version=1,
        name="agent",
        executor=ExecutorSpec(type="omnigent", config={}),
        os_env=os_env,
    )

    # Bare AgentSpec: returned directly.
    assert _agent_os_env_from_spec(bare) is os_env
    # ResolvedSpec wrapper: unwrapped to the inner spec's os_env.
    assert _agent_os_env_from_spec(ResolvedSpec(spec=bare, workdir=None)) is os_env
    # No spec at all: None (caller then uses the platform default).
    assert _agent_os_env_from_spec(None) is None
    # AgentSpec without an os_env block: None.
    no_os_env = AgentSpec(
        spec_version=1,
        name="agent",
        executor=ExecutorSpec(type="omnigent", config={}),
    )
    assert _agent_os_env_from_spec(no_os_env) is None


@dataclass
class _PublishedEvent:
    """
    One event captured from the runner's per-session publisher.

    :param session_id: Routing session id the event was published under,
        e.g. ``"c74c7a36c4736e2153ed6046d16bcf76"``.
    :param event: The published SSE event dict.
    """

    session_id: str
    event: dict[str, Any]


def test_publish_terminal_pending_emits_pending_then_clear() -> None:
    """
    ``_publish_terminal_pending`` emits the wire shape the Omnigent relay
    consumes for the Terminal-pill spinner.

    The session-creation handler calls this with ``True`` before
    auto-creating a terminal-first session's terminal and ``False`` in a
    ``finally`` (so a failed launch also clears the spinner). The AP
    relay matches on ``type == "session.terminal_pending"`` and reads
    the ``pending`` flag, so both fields must be present and correct, or
    the spinner would never appear (or never clear).
    """
    published: list[_PublishedEvent] = []

    def _capture(session_id: str, event: dict[str, Any]) -> None:
        published.append(_PublishedEvent(session_id=session_id, event=event))

    publish_terminal_pending(_capture, "7cef62c6518d5591cc7991974e33ec4c", True)
    publish_terminal_pending(_capture, "7cef62c6518d5591cc7991974e33ec4c", False)

    assert [p.event for p in published] == [
        {"type": "session.terminal_pending", "pending": True},
        {"type": "session.terminal_pending", "pending": False},
    ]
    # Routed under the session id so the Omnigent relay forwards it to that
    # session's web stream.
    assert all(p.session_id == "7cef62c6518d5591cc7991974e33ec4c" for p in published)


@dataclass
class _AutoCreateScenario:
    """
    One parametrized case for the claude-native auto-create guard.

    :param case_id: Human-readable scenario id used as the pytest id,
        e.g. ``"clear_rotation_target_skips"``.
    :param active_session_id: ``active_session_id`` to seed into the
        shared bridge config, e.g. ``"3bb59abc6e20b834cbb2269f28880895"``. ``None`` seeds no
        bridge dir at all (models a genuinely fresh session).
    :param terminal_under: Session id to seed a live ``claude:main``
        terminal under in the registry, e.g. ``"3bb59abc6e20b834cbb2269f28880895"``. ``None``
        seeds no terminal (models a dead/absent original terminal).
    :param bridge_id_label: Value returned for the new session's
        ``BRIDGE_ID_LABEL_KEY`` label, e.g. ``"bridge_shared"`` for a
        rotation target (shares the original's bridge) or ``"2d1b1a96e3e08f2cd43c0cc4b695ac5d"``
        for a fresh session (own bridge).
    :param expect_auto_create: Whether the guard should invoke
        ``_auto_create_claude_terminal`` for the new session.
    """

    case_id: str
    active_session_id: str | None
    terminal_under: str | None
    bridge_id_label: str
    expect_auto_create: bool


class _LabelsAndEmptyHistoryServerClient:
    """
    Server-client stub for the auto-create guard route test.

    Answers the two GETs ``create_session`` issues for a claude-native
    session: the session snapshot (returns a ``BRIDGE_ID_LABEL_KEY``
    label so the guard can resolve the bridge id) and the items page
    (returns empty history so no crash-recovery turn starts). A real
    stub class — not ``MagicMock`` — so an unexpected call shape fails
    loudly instead of silently returning a mock.
    """

    def __init__(self, bridge_id_label: str) -> None:
        """
        :param bridge_id_label: Bridge id to report on the session's
            ``labels``, e.g. ``"bridge_shared"``.
        """
        self._bridge_id_label = bridge_id_label


_AUTO_CREATE_SCENARIOS = [
    # Rotation target: the bridge's active session (conv_old) still owns
    # the live terminal that is about to be transferred onto conv_new.
    _AutoCreateScenario(
        case_id="clear_rotation_target_skips",
        active_session_id="3bb59abc6e20b834cbb2269f28880895",
        terminal_under="3bb59abc6e20b834cbb2269f28880895",
        bridge_id_label="bridge_shared",
        expect_auto_create=False,
    ),
    # Fresh host-spawned session: its own bridge has no recorded active
    # session and no terminal, so it must bootstrap its own Claude.
    _AutoCreateScenario(
        case_id="fresh_session_creates",
        active_session_id=None,
        terminal_under=None,
        bridge_id_label="2d1b1a96e3e08f2cd43c0cc4b695ac5d",
        expect_auto_create=True,
    ),
    # The bridge's active session is conv_new itself (e.g. a relaunch
    # after the terminal died) — not a rotation, so auto-create proceeds.
    _AutoCreateScenario(
        case_id="active_is_self_creates",
        active_session_id="2d1b1a96e3e08f2cd43c0cc4b695ac5d",
        terminal_under=None,
        bridge_id_label="bridge_shared",
        expect_auto_create=True,
    ),
    # The bridge names an active sibling (conv_old) but no live terminal
    # exists under it — nothing to transfer in, so auto-create proceeds.
    _AutoCreateScenario(
        case_id="dead_terminal_under_active_creates",
        active_session_id="3bb59abc6e20b834cbb2269f28880895",
        terminal_under=None,
        bridge_id_label="bridge_shared",
        expect_auto_create=True,
    ),
]


class _BlockingRecoveryServerClient:
    """Block durable inbox recovery while rejecting redundant init reads."""

    def __init__(self) -> None:
        self.recovery_started = asyncio.Event()
        self.release_recovery = asyncio.Event()
        self.recovery_completed = asyncio.Event()
        self.requests: list[str] = []

    async def get(self, url: str, **kwargs: Any) -> Any:
        """Serve recovery/history reads and fail any session metadata callback."""
        del kwargs
        self.requests.append(url)
        if url.endswith("/child_sessions"):
            self.recovery_started.set()
            await self.release_recovery.wait()
            self.recovery_completed.set()
            return httpx.Response(
                200,
                json={"data": [], "has_more": False},
                request=httpx.Request("GET", url),
            )
        if url.endswith("/items"):
            return httpx.Response(
                200,
                json={"data": [], "has_more": False},
                request=httpx.Request("GET", url),
            )
        raise AssertionError(f"unexpected runner-init GET: {url}")


class _DeletingRecoveryServerClient:
    """Pause the first recovery after one child is delivered."""

    def __init__(self, parent_id: str, first_child_id: str, second_child_id: str) -> None:
        self.parent_id = parent_id
        self.first_child_id = first_child_id
        self.second_child_id = second_child_id
        self.scan_count = 0
        self.second_child_read_started = asyncio.Event()
        self.first_recovery_cancelled = asyncio.Event()

    def _child_summary(self, child_id: str, dispatch_id: str) -> dict[str, Any]:
        return {
            "id": child_id,
            "tool": "reviewer",
            "session_name": child_id,
            "current_task_status": "completed",
            "labels": {runner_app.SUBAGENT_DISPATCH_ID_LABEL_KEY: dispatch_id},
        }

    @staticmethod
    def _response(payload: dict[str, Any]) -> httpx.Response:
        return httpx.Response(
            200,
            json=payload,
            request=httpx.Request("GET", "http://test-server"),
        )

    async def get(self, url: str, **kwargs: Any) -> httpx.Response:
        del kwargs
        if url.endswith(f"/{self.parent_id}/child_sessions"):
            self.scan_count += 1
            return self._response(
                {
                    "data": [
                        self._child_summary(self.first_child_id, "dispatch-first"),
                        self._child_summary(self.second_child_id, "dispatch-second"),
                    ],
                    "has_more": False,
                }
            )
        if url.endswith(f"/{self.first_child_id}/items"):
            return self._response(
                {
                    "data": [
                        {
                            "type": "message",
                            "role": "assistant",
                            "content": [{"type": "output_text", "text": "first result"}],
                        }
                    ],
                    "has_more": False,
                }
            )
        if url.endswith(f"/{self.second_child_id}/items"):
            if self.scan_count == 1:
                self.second_child_read_started.set()
                try:
                    await asyncio.Event().wait()
                except asyncio.CancelledError:
                    self.first_recovery_cancelled.set()
                    raise
            return self._response(
                {
                    "data": [
                        {
                            "type": "message",
                            "role": "assistant",
                            "content": [{"type": "output_text", "text": "second result"}],
                        }
                    ],
                    "has_more": False,
                }
            )
        if url.endswith(f"/{self.parent_id}/items"):
            return self._response({"data": [], "has_more": False})
        raise AssertionError(f"unexpected runner-init GET: {url}")

    async def post(self, url: str, **kwargs: Any) -> httpx.Response:
        del kwargs
        return httpx.Response(200, request=httpx.Request("POST", url))


# ── What a plain claude-native launch must NOT carry ─────────────────
#
# A session created without Smart Routing has to launch byte-for-byte like a
# pre-Smart-Routing one: no spawn-routing endpoint (so no loopback server, no
# bearer token on disk, and no ``Task`` PreToolUse hook paying a hook
# subprocess plus a round trip on every spawn), and no custom-picker-slot pin
# displacing the workspace's own picker row.
#
# Accepted consequence: the class is stamped at create, so flipping the gear's
# Subagent-routing toggle on for a plain session is inert until recreate.
