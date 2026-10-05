"""The single registration seam for a Super Chat primitive.

One folder per primitive under ``omnigent/superchat/<name>/`` exposes a :class:`Feature`; the
three framework seams iterate :data:`omnigent.superchat.features.FEATURES` instead of growing a
per-primitive branch each:

* ``tools/manager.py`` registers every feature's label-gated tool defs.
* ``runner/tool_dispatch.py`` routes a feature tool name to its handler.
* ``server/app.py`` calls :func:`install_features` (stores + routers) and runs the jobs.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Protocol

from omnigent.context.labels import SUBAGENT_LABEL_KEY, is_superside_chat

if TYPE_CHECKING:
    import httpx
    from fastapi import FastAPI

    from omnigent.tools.base import Tool


def is_super_chat(labels: Mapping[str, str] | None) -> bool:
    """True for the top-level Super Chat session itself (never a Helper)."""
    return is_superside_chat(labels) and SUBAGENT_LABEL_KEY not in (labels or {})


def is_helper(labels: Mapping[str, str] | None) -> bool:
    """True for a Super Chat's Helper (sub-agent session)."""
    return is_superside_chat(labels) and SUBAGENT_LABEL_KEY in (labels or {})


@dataclass(frozen=True)
class ToolManagerCtx:
    """What a feature's ``tools`` factory may need from the ToolManager (kept minimal)."""

    spec: Any = None


@dataclass(frozen=True)
class SpawnRequest:
    """One sub-agent launch a handler asks the runner for (the generic create path).

    :param agent: The declared Sub-agent Type to start.
    :param task: The brief (the child's first message).
    :param title: Instance label, or ``None`` to leave naming to the engine.
    :param model: The ``fast`` / ``strong`` choice.
    :param reasoning_effort: ``low`` / ``medium`` / ``high``, or ``None`` for the default.
    :param file_ids: Uploaded file ids to hand to the child.
    """

    agent: str
    task: str
    title: str | None = None
    model: str = "strong"
    reasoning_effort: str | None = None
    file_ids: tuple[str, ...] = ()


@dataclass(frozen=True)
class SpawnResult:
    """Outcome of a :class:`SpawnRequest`: the child's id, or why it was refused.

    :param child_id: The started child session (``None`` on refusal).
    :param error: The runner's refusal reason, without a tool-name prefix.
    """

    child_id: str | None = None
    error: str = ""


@dataclass(frozen=True)
class SubAgentHost:
    """What the runner offers a handler that starts sub-agents (built in ``tool_dispatch``).

    :param declared_types: Names of the Sub-agent Types the calling session declares.
    :param child_titles: Titles of the caller's existing child sessions.
    :param spawn: Starts one child through the generic sub-agent create path.
    """

    declared_types: tuple[str, ...]
    child_titles: Callable[[], Awaitable[list[str]]]
    spawn: Callable[[SpawnRequest], Awaitable[SpawnResult]]


@dataclass(frozen=True)
class HandlerCtx:
    """What a runner-side feature handler needs about the call.

    :param tool_name: The tool being called.
    :param server_client: HTTP client pointed at the Omnigent server (``None`` outside a runner).
    :param conversation_id: The calling session.
    :param labels: The calling session's labels, when the dispatcher has them.
    :param sub_agents: The runner's sub-agent launcher (``None`` outside a runner).
    """

    tool_name: str
    server_client: httpx.AsyncClient | None
    conversation_id: str | None
    labels: Mapping[str, str] | None = None
    sub_agents: SubAgentHost | None = None


@dataclass(frozen=True)
class InstallDeps:
    """Server objects a feature's ``install`` may wire its store and router with."""

    scheduled_task_store: Any
    conversation_store: Any
    agent_store: Any
    permission_store: Any
    auth_provider: Any
    agent_cache: Any = None
    runner_router: Any = None
    objective_store: Any = None


class BackgroundJob(Protocol):
    """A feature's background worker: started with the app, stopped on shutdown."""

    def start(self) -> Any:
        """Start the job (may be sync or return an awaitable)."""

    def shutdown(self) -> Any:
        """Stop the job (may be sync or return an awaitable)."""


Handler = Callable[[HandlerCtx, dict[str, Any]], Awaitable[str]]
ResultListener = Callable[[HandlerCtx, str], None]


@dataclass(frozen=True)
class Feature:
    """One Super Chat primitive's registration surface.

    :param name: Folder / feature name, e.g. ``"vault"``.
    :param tools: ``(labels, ctx) -> tool defs`` (label-gated: Super Chat vs Helper).
    :param handlers: ``tool_name -> async handler`` run on the runner.
    :param on_result: Sees every feature handler's ``(ctx, output)`` after it ran (any feature's
        tool), so a feature can follow another's results without importing it.
    :param install: Wires stores + routers onto the FastAPI app.
    :param jobs: Returns background jobs (objects with ``start()`` / ``shutdown()``).
    """

    name: str
    tools: Callable[[Mapping[str, str] | None, ToolManagerCtx], list[Tool]]
    handlers: Mapping[str, Handler] = field(default_factory=dict)
    on_result: ResultListener | None = None
    install: Callable[[FastAPI, InstallDeps], None] | None = None
    jobs: Callable[[FastAPI], list[BackgroundJob]] | None = None
