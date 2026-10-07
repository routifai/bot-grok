"""Runner side of ``start_helper``: one Helper through the generic sub-agent create path.

The call is translated into the ``sys_session_send`` create-path arguments and run by the same
function, so session creation, Activity, the wake/result path, the concurrency caps, the nesting
refusal and the ``fast``/``strong`` model choice are exactly the existing ones.
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from collections.abc import Iterable, Mapping
from typing import Any

from omnigent.superchat.activity.titles import tidy_request_title
from omnigent.superchat.feature import HandlerCtx, SpawnRequest
from omnigent.superchat.subagents import HELPER_EFFORT_CHOICES, HELPER_MODEL_CHOICES

#: A repeat of the same task from the same chat inside this window is the same hand-off.
DEDUP_WINDOW_S = 10.0
_TITLE_MAX_CHARS = 48
_LEADING_AGENT_PREFIX = re.compile(r"^[^:]*:")

#: ``(chat id, normalized task) -> (monotonic start time, receipt)``.
_recent: dict[tuple[str, str], tuple[float, str]] = {}
_locks: dict[str, asyncio.Lock] = {}


#: A Sub-agent Type's own ``params:`` key declaring its Helper role (``worker`` or ``subworker``).
HELPER_TYPE_PARAM = "helper_type"
_ROLES = ("worker", "subworker")


def declared_role(sub: Any) -> str | None:
    """The Helper role a Sub-agent Type spec declares in ``params.helper_type``, if valid."""
    params = getattr(sub, "params", None)
    value = params.get(HELPER_TYPE_PARAM) if isinstance(params, Mapping) else None
    default = getattr(value, "default", value)  # the inner loader wraps scalars in ParamDef
    return default if default in _ROLES else None


def helper_roles_for(spec: Any) -> dict[str, str]:
    """``{type name: role}`` for the declared Types of ``spec`` that declare a role."""
    return {
        name: role
        for sub in getattr(spec, "sub_agents", None) or []
        if isinstance(name := getattr(sub, "name", None), str)
        and (role := declared_role(sub)) is not None
    }


def helper_role(name: str, roles: Mapping[str, str] | None = None) -> str | None:
    """The role of Type ``name``: its declared role, else ``name`` itself if it is a role."""
    return (roles or {}).get(name) or (name if name in _ROLES else None)


def helper_type(declared: Iterable[str], roles: Mapping[str, str] | None = None) -> str | None:
    """The Helper Type a caller starts: a ``worker`` Type if declared, else a ``subworker`` one.

    A Type's role comes from its ``params.helper_type``; a Type named ``worker`` or ``subworker``
    that declares nothing keeps that role.
    """
    names = [n for n in declared if not n.startswith("__")]
    for wanted in _ROLES:
        for name in names:
            if helper_role(name, roles) == wanted:
                return name
    return None


def helper_type_for(spec: Any) -> str | None:
    """:func:`helper_type` for the Types ``spec`` declares (tool gating, before any call)."""
    return helper_type(
        (
            n
            for sub in getattr(spec, "sub_agents", None) or []
            if isinstance(n := getattr(sub, "name", None), str)
        ),
        helper_roles_for(spec),
    )


def helper_title(task: str, taken: set[str]) -> str | None:
    """A short sentence-case title from the first words of ``task``, unique among ``taken``.

    ``None`` leaves naming to the engine (an ordinal the Activity feed replaces by the task).
    """
    base = tidy_request_title(task, limit=_TITLE_MAX_CHARS)
    if base is None:
        return None
    base = base.replace(":", " ").strip()
    candidate, n = base, 1
    while candidate.casefold() in taken:
        n += 1
        candidate = f"{base} {n}"
    return candidate


def _normalize(task: str) -> str:
    return " ".join(task.casefold().split())


def _receipt(title: str, helper_id: str, *, agent: str = "worker") -> str:
    """The receipt; ``agent`` is the Type started, ``subworker`` when the caller is a worker."""
    if agent == "subworker":
        message = (
            f"Part started on '{title}'. Its result will arrive here as a message. When every "
            "part you started has reported, write the deliverable yourself; do not tell anyone. "
            "Do not end your turn without the deliverable unless you are waiting for parts."
        )
    else:
        message = (
            f"Helper started on '{title}'. Its result will arrive here as a message when it "
            "finishes. Tell the person in one sentence that you started it, then end your "
            "turn; do not wait or poll."
        )
    return json.dumps(
        {"started": True, "helper_id": helper_id, "title": title, "message": message}
    )


def _refusal(reason: str) -> str:
    return f"Error: start_helper: {reason}"


def _invalid_input(args: dict[str, Any]) -> str | None:
    """Why ``args`` cannot start a Helper (said in ``start_helper`` terms), or ``None``."""
    task = args.get("task")
    if not isinstance(task, str) or not task.strip():
        return "requires a non-empty 'task'"
    extra = set(args) - {"task", "model", "reasoning", "files"}
    if extra:
        return f"does not take {', '.join(sorted(extra))}"
    if args.get("model", "strong") not in HELPER_MODEL_CHOICES:
        return f"'model' must be one of {', '.join(HELPER_MODEL_CHOICES)}"
    reasoning = args.get("reasoning")
    if reasoning is not None and reasoning not in HELPER_EFFORT_CHOICES:
        return f"'reasoning' must be one of {', '.join(HELPER_EFFORT_CHOICES)}"
    files = args.get("files")
    if files is not None and not (
        isinstance(files, list) and all(isinstance(f, str) and f for f in files)
    ):
        return "'files' must be a list of uploaded file ids"
    return None


def _prune(now: float) -> None:
    """Forget finished dedup entries and the per-chat locks nothing refers to any more."""
    for stale in [k for k, (at, _) in _recent.items() if now - at > DEDUP_WINDOW_S]:
        del _recent[stale]
    live_chats = {chat for chat, _ in _recent}
    for chat in [c for c, lock in _locks.items() if c not in live_chats and not lock.locked()]:
        del _locks[chat]


async def handle_start_helper(ctx: HandlerCtx, args: dict[str, Any]) -> str:
    """
    Start one Helper from a ``start_helper`` call.

    :param ctx: The call context (carries the runner's sub-agent launcher).
    :param args: ``task`` plus optional ``model``, ``reasoning`` and ``files``.
    :returns: A short receipt JSON, or an ``Error: ...`` string the model can act on.
    """
    host = ctx.sub_agents
    if host is None or not ctx.conversation_id:
        return "Error: start_helper requires server access"
    agent = helper_type(host.declared_types, host.helper_roles)
    if agent is None:
        return "Error: start_helper is not available here"
    invalid = _invalid_input(args)
    if invalid is not None:
        return _refusal(invalid)
    task: str = args["task"]
    key = (ctx.conversation_id, _normalize(task))

    async with _locks.setdefault(ctx.conversation_id, asyncio.Lock()):
        _prune(time.monotonic())
        if key in _recent:
            return _recent[key][1]

        taken = {
            _LEADING_AGENT_PREFIX.sub("", title).strip().casefold()
            for title in await host.child_titles()
        }
        title = helper_title(task, taken)
        result = await host.spawn(
            SpawnRequest(
                agent=agent,
                task=task,
                title=title,
                model=args.get("model", "strong"),
                reasoning_effort=args.get("reasoning"),
                file_ids=tuple(args.get("files") or ()),
            )
        )
        if result.child_id is None:
            return _refusal(result.error)
        receipt = _receipt(
            title or "your task",
            result.child_id,
            agent=helper_role(agent, host.helper_roles) or "worker",
        )
        _recent[key] = (time.monotonic(), receipt)
        return receipt
