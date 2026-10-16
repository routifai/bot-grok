"""Native-harness interrupt / stop control for the runner app.

The runner receives ``interrupt`` and ``stop_session`` events on
``/v1/sessions/{id}/events`` and must forward them into the resident vendor
TUI/bridge for the session's native harness. The per-harness logic used to be
sixteen closures inside :mod:`omnigent.runner.app`; this module collapses them
onto one :class:`NativeInterruptRunner` so the dispatch is registry-driven.

Mirrors :class:`omnigent.runner.codex.goal.CodexGoalRunner`: app-scope state
(the AP client, resource registry, event publisher, sub-agent wake plumbing) is
injected at construction so the class stays out of the already-large app module
while preserving the exact behavior of the original closures.

claude interrupt (bridge-id resolution), codex interrupt (MCP-startup +
app-server ``turn/interrupt``) and pi interrupt (bridge ``enqueue_interrupt``)
each have a dedicated method. claude has a dedicated stop; codex/pi have no
distinct stop and alias it to their interrupt handler.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Callable, Mapping
from typing import TYPE_CHECKING, Protocol

import httpx
from fastapi.responses import JSONResponse, Response

from omnigent.native.native_coding_agents import native_coding_agent_for_harness
from omnigent.runner.native.orchestration import (
    _claude_native_bridge_id_for_session,
    _session_labels_for_runner_spawn,
)
from omnigent.runner.resource_registry import SessionResourceRegistry

if TYPE_CHECKING:
    from omnigent.harness_plugins import NativeCodingAgent
    from omnigent.harnesses.codex_native.bridge import CodexNativeBridgeState


class SubagentDeliveryAck(Protocol):
    """Result of attempting to deliver a terminal sub-agent payload."""

    @property
    def delivered(self) -> bool:
        raise NotImplementedError

    @property
    def entry(self) -> object | None:
        raise NotImplementedError

    @property
    def reason(self) -> str:
        raise NotImplementedError


class MarkSubagentTerminalAndWake(Protocol):
    """Mark a sub-agent work entry terminal and wake its parent."""

    def __call__(
        self,
        child_session_id: str,
        *,
        status: str,
        output: str | None,
        only_if_work_id: str | None = None,
    ) -> SubagentDeliveryAck:
        raise NotImplementedError


class ClientSafeErrorDetail(Protocol):
    """Log an exception and return safe client-facing detail."""

    def __call__(self, exc: BaseException, *, context: str) -> str:
        raise NotImplementedError


class SubagentWorkIdForSession(Protocol):
    """Return the ``work_id`` of the dispatch currently registered for a child."""

    def __call__(self, conv_id: str) -> str | None:
        raise NotImplementedError


class CodexBridgeStateForSession(Protocol):
    """Resolve a live Codex app-server bridge state for a session."""

    async def __call__(
        self,
        conv_id: str,
        *,
        action: str,
        missing_state_log_level: int = logging.WARNING,
    ) -> CodexNativeBridgeState | None:
        raise NotImplementedError


def native_agent_for_cancel(wrapper_label: str | None) -> NativeCodingAgent | None:
    """Resolve a native agent from a session wrapper or sub-agent wrapper label.

    :param wrapper_label: ``omnigent.wrapper`` value, e.g. ``"claude-code-native-ui"``
        or ``"claude-code-native-ui-subagent"``.
    :returns: The matching :class:`~omnigent.harness_plugins.NativeCodingAgent`,
        or ``None`` when the label is missing or not native.
    """
    from omnigent.native.native_coding_agents import (
        NATIVE_CODING_AGENTS,
        native_coding_agent_for_wrapper_label,
    )

    agent = native_coding_agent_for_wrapper_label(wrapper_label)
    if agent is not None:
        return agent
    if not wrapper_label:
        return None
    for candidate in NATIVE_CODING_AGENTS:
        if candidate.subagent_wrapper_label == wrapper_label:
            return candidate
    return None


def native_cancel_capability(wrapper_label: str | None) -> str:
    """Classify a child's wrapper for parent-side ``sys_cancel_task`` routing.

    Mirrors :meth:`NativeInterruptRunner.stop` instead of comparing one Claude
    wrapper label:

    * ``"stop"`` — Claude's dedicated stop
    * ``"best_effort"`` — remaining native agents (Codex/Pi alias stop to
      interrupt)
    * ``"inprocess"`` — no native agent for this label

    :param wrapper_label: The work entry's ``omnigent.wrapper`` value.
    :returns: One of ``"stop"``, ``"best_effort"``, or ``"inprocess"``.
    """
    agent = native_agent_for_cancel(wrapper_label)
    if agent is None:
        return "inprocess"
    if agent.key == "claude":
        return "stop"
    return "best_effort"


# How long an unresolved interrupt may wait for the harness's own terminal
# edge before the dispatch is reported ``cancelled`` to the parent anyway.
# An interrupted native agent usually aborts without firing any turn-end
# hook, so this timer is the liveness floor that keeps the parent from
# hanging; a confirmed completion that lands later still corrects the record.
_NATIVE_INTERRUPT_CANCEL_GRACE_S = 20.0


class NativeInterruptRunner:
    """Forward interrupt / stop events into a session's native harness bridge."""

    def __init__(
        self,
        *,
        server_client: httpx.AsyncClient,
        resource_registry: SessionResourceRegistry,
        publish_event: Callable[[str, dict[str, object]], None],
        mark_subagent_terminal_and_wake: MarkSubagentTerminalAndWake,
        session_sub_agent_names: Mapping[str, str],
        codex_bridge_state_for_session: CodexBridgeStateForSession,
        client_safe_error_detail: ClientSafeErrorDetail,
        logger: logging.Logger,
        subagent_work_id_for_session: SubagentWorkIdForSession | None = None,
    ) -> None:
        self._server_client = server_client
        self._resource_registry = resource_registry
        self._publish_event = publish_event
        self._mark_subagent_terminal_and_wake = mark_subagent_terminal_and_wake
        self._session_sub_agent_names = session_sub_agent_names
        self._codex_bridge_state_for_session = codex_bridge_state_for_session
        self._client_safe_error_detail = client_safe_error_detail
        self._logger = logger
        self._subagent_work_id_for_session = subagent_work_id_for_session
        # Sessions whose native interrupt was injected but whose turn outcome is
        # still unknown; resolved by the next terminal edge or the grace timer,
        # whichever lands first. The value is the ``work_id`` of the dispatch the
        # interrupt was raised for, so a delayed cancel never lands on a newer
        # send that reused the same child session.
        self._pending_interrupts: dict[str, str | None] = {}
        self._pending_interrupt_timers: dict[str, asyncio.TimerHandle] = {}

    async def interrupt(self, harness_name: str | None, conv_id: str) -> Response | None:
        """Dispatch an interrupt to the harness's bridge.

        :returns: A response when this harness has an interrupt handler, else
            ``None`` so the caller falls through to the in-process turn cancel.
        """
        agent = native_coding_agent_for_harness(harness_name)
        if agent is None:
            return None
        key = agent.key
        if key == "claude":
            return await self._claude_interrupt(conv_id)
        if key == "codex":
            return await self._codex_interrupt(conv_id)
        if key == "pi":
            return await self._pi_interrupt(conv_id)
        return None

    async def stop(self, harness_name: str | None, conv_id: str) -> Response | None:
        """Dispatch a stop_session to the harness's bridge.

        codex/pi have no distinct stop — they route to their interrupt handler,
        exactly as the original dispatch chain did.

        :returns: A response when this harness has a stop handler, else ``None``
            so the caller falls through to the in-process turn cancel.
        """
        agent = native_coding_agent_for_harness(harness_name)
        if agent is None:
            return None
        key = agent.key
        if key == "claude":
            return await self._claude_stop(conv_id)
        if key in ("codex", "pi"):
            return await self.interrupt(harness_name, conv_id)
        return None

    def _defer_parent_wake_after_native_interrupt(self, conv_id: str) -> None:
        """Record the interrupt instead of guessing a terminal status.

        Injecting an Escape does not confirm the agent stopped: it may abort
        mid-task or survive and finish. Reporting ``cancelled`` here locked the
        dispatch and discarded a genuine result that landed afterwards. The
        outcome is decided by whichever arrives first: the harness's terminal
        edge (``external_session_status``) or the grace timer.
        """
        # Capture the dispatch this interrupt is for so a delayed cancel can be
        # bound to it and never lands on a newer send that reused this session.
        work_id = (
            self._subagent_work_id_for_session(conv_id)
            if self._subagent_work_id_for_session is not None
            else None
        )
        # Deduplicate only within the SAME dispatch. A pending record left by an
        # earlier dispatch (e.g. one the launch reaper failed before its timer
        # fired) must not suppress a new dispatch's own record and timer — that
        # would leave the new dispatch with no cancellation fallback while the
        # stale timer rejects itself as superseded. Replace the stale record.
        if conv_id in self._pending_interrupts and self._pending_interrupts[conv_id] == work_id:
            return
        stale_timer = self._pending_interrupt_timers.pop(conv_id, None)
        if stale_timer is not None:
            stale_timer.cancel()
        self._pending_interrupts[conv_id] = work_id
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._pending_interrupt_timers[conv_id] = loop.call_later(
            _NATIVE_INTERRUPT_CANCEL_GRACE_S,
            self._deliver_unconfirmed_interrupt_cancel,
            conv_id,
        )

    def take_pending_interrupt(self, conv_id: str) -> tuple[bool, str | None]:
        """Consume a recorded-but-unresolved interrupt for *conv_id*.

        :returns: ``(was_pending, work_id)`` — whether an interrupt was pending
            and the ``work_id`` it was raised for (``None`` when unknown). The
            caller now owns resolving that dispatch's terminal status, binding
            any cancel to ``work_id`` so it cannot settle a newer dispatch.
        """
        was_pending = conv_id in self._pending_interrupts
        work_id = self._pending_interrupts.pop(conv_id, None)
        timer = self._pending_interrupt_timers.pop(conv_id, None)
        if timer is not None:
            timer.cancel()
        return was_pending, work_id

    def resolve_pending_interrupt(
        self, conv_id: str, current_work_id: str | None
    ) -> tuple[bool, str | None]:
        """Consume a pending interrupt only when it belongs to the current dispatch.

        A pending interrupt records the ``work_id`` it was raised for. When an
        idle edge arrives for *conv_id*, it resolves that interrupt only if the
        dispatch now registered is the same one; otherwise the pending record is
        stale (its dispatch exited or was superseded by a new send that reused
        the child) and must NOT capture this idle — for a legacy harness that
        idle is the *new* dispatch's completion. The stale record is dropped and
        ``(False, None)`` returned so the caller processes the idle normally.

        :param conv_id: Session/conversation id, e.g. ``"conv_abc123"``.
        :param current_work_id: ``work_id`` of the dispatch now registered for
            *conv_id*, or ``None`` when none is tracked.
        :returns: ``(resolved, work_id)`` — ``resolved`` is ``True`` only when a
            pending interrupt for the current dispatch was consumed.
        """
        if conv_id not in self._pending_interrupts:
            return False, None
        pending_work_id = self._pending_interrupts.get(conv_id)
        if current_work_id is None or pending_work_id != current_work_id:
            # Stale (or unbindable) pending: drop it, but let the idle be
            # handled as the current dispatch's own outcome.
            self.clear_pending_interrupt(conv_id)
            return False, None
        self.take_pending_interrupt(conv_id)
        return True, pending_work_id

    def clear_pending_interrupt(self, conv_id: str) -> None:
        """Drop any recorded interrupt whose outcome another path resolved."""
        self.take_pending_interrupt(conv_id)

    def _deliver_unconfirmed_interrupt_cancel(self, conv_id: str) -> None:
        """Grace-timer fallback: no terminal edge followed the interrupt."""
        was_pending, work_id = self.take_pending_interrupt(conv_id)
        if not was_pending:
            return
        if work_id is None:
            # The interrupt was never bound to a dispatch (no work entry existed
            # when it fired — e.g. a runner restart hadn't recovered it yet).
            # Delivering ``cancelled`` now could settle a *newer* send that has
            # since reused this child session, permanently mislabeling it. Skip:
            # the restart recovery scan owns children with no live work entry.
            self._logger.info(
                "Native interrupt grace timer: no dispatch bound for session=%s; "
                "skipping cancel to avoid settling a reused dispatch",
                conv_id,
            )
            return
        delivery_ack = self._mark_subagent_terminal_and_wake(
            conv_id,
            status="cancelled",
            output=None,
            only_if_work_id=work_id,
        )
        if not delivery_ack.delivered and (
            delivery_ack.entry is not None or conv_id in self._session_sub_agent_names
        ):
            self._logger.warning(
                "Native interrupt: sub-agent delivery not confirmed; session=%s reason=%s",
                conv_id,
                delivery_ack.reason,
            )

    async def _teardown_session_terminals(self, conv_id: str) -> None:
        from omnigent.entities.session_resources import terminal_resource_id
        from omnigent.runner.tool_dispatch import _publish_terminal_deleted_event

        terminal_registry = self._resource_registry.terminal_registry
        if terminal_registry is None:
            return
        terminals = [
            (entry.terminal_name, entry.session_key)
            for entry in terminal_registry.list_for_conversation(conv_id)
        ]
        for terminal_name, session_key in terminals:
            terminal_id = terminal_resource_id(terminal_name, session_key)
            try:
                await self._resource_registry.close_terminal(conv_id, terminal_id)
            except (RuntimeError, OSError):
                self._logger.warning(
                    "Failed to close terminal %s for session %s during stop",
                    terminal_id,
                    conv_id,
                    exc_info=True,
                )
            _publish_terminal_deleted_event(
                conversation_id=conv_id,
                terminal_name=terminal_name,
                session_key=session_key,
                publish_event=self._publish_event,
            )

    async def _pi_interrupt(self, conv_id: str) -> Response:
        from omnigent.harnesses.pi_native.bridge import (
            bridge_dir_for_session_id,
            enqueue_interrupt,
        )

        try:
            await asyncio.to_thread(enqueue_interrupt, bridge_dir_for_session_id(conv_id))
        except OSError as exc:
            self._logger.warning(
                "pi-native interrupt failed for session=%s", conv_id, exc_info=True
            )
            return JSONResponse(
                status_code=503,
                content={
                    "error": "pi_native_interrupt_failed",
                    "detail": self._client_safe_error_detail(exc, context="pi-native interrupt"),
                },
            )
        self._defer_parent_wake_after_native_interrupt(conv_id)
        return Response(status_code=204)

    async def _claude_interrupt(self, conv_id: str) -> Response:
        from omnigent.harnesses.claude_native.bridge import (
            bridge_dir_for_bridge_id,
            inject_interrupt,
        )

        bridge_id = await _claude_native_bridge_id_for_session(
            server_client=self._server_client,
            session_id=conv_id,
        )
        bridge_dir = bridge_dir_for_bridge_id(bridge_id)
        try:
            await asyncio.to_thread(inject_interrupt, bridge_dir, timeout_s=1.0)
        except RuntimeError as exc:
            return JSONResponse(
                status_code=503,
                content={
                    "error": "claude_native_interrupt_failed",
                    "detail": self._client_safe_error_detail(
                        exc, context="claude-native interrupt"
                    ),
                },
            )
        self._defer_parent_wake_after_native_interrupt(conv_id)
        return Response(status_code=204)

    async def _claude_stop(self, conv_id: str) -> Response:
        from omnigent.harnesses.claude_native.bridge import (
            TmuxSessionNotAdvertised,
            bridge_dir_for_bridge_id,
            kill_session,
        )

        bridge_id = await _claude_native_bridge_id_for_session(
            server_client=self._server_client,
            session_id=conv_id,
        )
        bridge_dir = bridge_dir_for_bridge_id(bridge_id)
        try:
            await asyncio.to_thread(kill_session, bridge_dir, timeout_s=1.0)
        except TmuxSessionNotAdvertised:
            self._logger.debug("claude-native stop: no live tmux for %s", conv_id)
        except RuntimeError as exc:
            return JSONResponse(
                status_code=503,
                content={
                    "error": "claude_native_stop_failed",
                    "detail": self._client_safe_error_detail(exc, context="claude-native stop"),
                },
            )
        await self._teardown_session_terminals(conv_id)
        self._publish_event(conv_id, {"type": "session.status", "status": "idle"})
        # The kill is confirmed, so this ``cancelled`` is truthful and settles
        # any interrupt still waiting on its outcome.
        self.clear_pending_interrupt(conv_id)
        delivery_ack = self._mark_subagent_terminal_and_wake(
            conv_id,
            status="cancelled",
            output=None,
        )
        if not delivery_ack.delivered and (
            delivery_ack.entry is not None or conv_id in self._session_sub_agent_names
        ):
            self._logger.warning(
                "Claude-native stop succeeded but sub-agent delivery was "
                "not confirmed; session=%s reason=%s",
                conv_id,
                delivery_ack.reason,
            )
        return Response(status_code=204)

    async def _codex_interrupt(self, conv_id: str) -> Response:
        from omnigent.harnesses.codex_native.app_server import client_for_transport
        from omnigent.harnesses.codex_native.bridge import (
            CODEX_NATIVE_BRIDGE_ID_LABEL_KEY,
            bridge_dir_for_bridge_id,
            cancel_pending_mcp_startup,
            read_mcp_startup,
        )

        state = await self._codex_bridge_state_for_session(conv_id, action="interrupt")
        if state is None:
            return Response(status_code=204)
        labels = await _session_labels_for_runner_spawn(
            server_client=self._server_client,
            session_id=conv_id,
        )
        bridge_dir = bridge_dir_for_bridge_id(
            labels.get(CODEX_NATIVE_BRIDGE_ID_LABEL_KEY) or conv_id
        )
        pending_mcp = cancel_pending_mcp_startup(bridge_dir)
        if state.active_turn_id is None and not pending_mcp:
            self._logger.info(
                "Codex-native interrupt skipped for %s: no active turn or MCP startup.",
                conv_id,
            )
            return Response(status_code=204)
        if pending_mcp:
            self._logger.info(
                "Codex-native interrupt for %s cancels MCP startup: %s",
                conv_id,
                ", ".join(pending_mcp),
            )
            try:
                await self._server_client.post(
                    f"/v1/sessions/{conv_id}/events",
                    json={
                        "type": "external_mcp_startup",
                        "data": {"servers": read_mcp_startup(bridge_dir)},
                    },
                    timeout=10.0,
                )
            except Exception:
                self._logger.warning(
                    "Failed to publish cancelled MCP startup for %s", conv_id, exc_info=True
                )

        codex_client = client_for_transport(
            state.socket_path,
            client_name="omnigent-codex-native-runner",
        )
        try:
            await codex_client.connect()
            if pending_mcp:
                try:
                    await codex_client.request(
                        "turn/interrupt",
                        {"threadId": state.thread_id, "turnId": ""},
                    )
                except Exception:
                    self._logger.warning(
                        "Codex-native MCP startup interrupt failed for session=%s thread=%s",
                        conv_id,
                        state.thread_id,
                        exc_info=True,
                    )
            if state.active_turn_id is not None:
                await codex_client.request(
                    "turn/interrupt",
                    {
                        "threadId": state.thread_id,
                        "turnId": state.active_turn_id,
                    },
                )
        except Exception as exc:
            self._logger.warning(
                "Codex-native turn/interrupt failed for session=%s thread=%s turn=%s",
                conv_id,
                state.thread_id,
                state.active_turn_id,
                exc_info=True,
            )
            return JSONResponse(
                status_code=503,
                content={
                    "error": "codex_native_interrupt_failed",
                    "detail": self._client_safe_error_detail(
                        exc, context="codex-native interrupt"
                    ),
                },
            )
        finally:
            with contextlib.suppress(Exception):
                await codex_client.close()
        self._defer_parent_wake_after_native_interrupt(conv_id)
        return Response(status_code=204)
