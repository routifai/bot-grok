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
from typing import Any

from omnigent.superchat.activity.titles import tidy_request_title
from omnigent.superchat.feature import HandlerCtx

#: A repeat of the same task from the same chat inside this window is the same hand-off.
DEDUP_WINDOW_S = 10.0
_TITLE_MAX_CHARS = 48
_LEADING_AGENT_PREFIX = re.compile(r"^[^:]*:")

#: ``(chat id, normalized task) -> (monotonic start time, receipt)``.
_recent: dict[tuple[str, str], tuple[float, str]] = {}
_locks: dict[str, asyncio.Lock] = {}


def helper_type_for(spec: Any) -> str | None:
    """The Helper type a caller starts: ``worker`` from the Muse, ``subworker`` from a worker."""
    names = [
        n
        for sub in getattr(spec, "sub_agents", None) or []
        if isinstance(n := getattr(sub, "name", None), str) and not n.startswith("__")
    ]
    if "worker" in names:
        return "worker"
    return "subworker" if "subworker" in names else None


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


async def handle_start_helper(ctx: HandlerCtx, args: dict[str, Any]) -> str:
    """
    Start one Helper from a ``start_helper`` call.

    :param ctx: The call context (carries the caller's spec and inbox).
    :param args: ``task`` plus optional ``model``, ``reasoning`` and ``files``.
    :returns: A short receipt JSON, or an ``Error: ...`` string the model can act on.
    """
    from omnigent.runner.tool_dispatch import _execute_subagent_tool, _list_child_sessions

    task = args.get("task")
    if not isinstance(task, str) or not task.strip():
        return "Error: start_helper requires a non-empty 'task'"
    if ctx.server_client is None or not ctx.conversation_id:
        return "Error: start_helper requires server access"
    agent = helper_type_for(ctx.agent_spec)
    if agent is None:
        return "Error: start_helper is not available here"
    extra = set(args) - {"task", "model", "reasoning", "files"}
    if extra:
        return f"Error: start_helper does not take {', '.join(sorted(extra))}"
    key = (ctx.conversation_id, _normalize(task))

    async with _locks.setdefault(ctx.conversation_id, asyncio.Lock()):
        now = time.monotonic()
        for stale in [k for k, (at, _) in _recent.items() if now - at > DEDUP_WINDOW_S]:
            del _recent[stale]
        if key in _recent:
            return _recent[key][1]

        rows = await _list_child_sessions(
            server_client=ctx.server_client, conversation_id=ctx.conversation_id
        )
        taken = {
            _LEADING_AGENT_PREFIX.sub("", str(row.get("title") or "")).strip().casefold()
            for row in (rows if isinstance(rows, list) else [])
        }
        title = helper_title(task, taken)
        message: dict[str, Any] = {"input": task, "model": args.get("model", "strong")}
        if args.get("reasoning") is not None:
            message["reasoning_effort"] = args["reasoning"]
        if args.get("files"):
            message["file_ids"] = args["files"]
        send_args: dict[str, Any] = {"agent": agent, "args": message}
        if title:
            send_args["title"] = title
        output = await _execute_subagent_tool(
            send_args,
            server_client=ctx.server_client,
            conversation_id=ctx.conversation_id,
            agent_spec=ctx.agent_spec,
            publish_event=ctx.publish_event,
            session_inbox=ctx.session_inbox,
            labels=ctx.labels,
        )
        try:
            handle = json.loads(output)
        except ValueError:
            handle = None
        if not isinstance(handle, dict) or not isinstance(handle.get("task_id"), str):
            return output.replace("sys_session_send", "start_helper")
        receipt = _receipt(title or "your task", handle["task_id"], agent=agent)
        _recent[key] = (time.monotonic(), receipt)
        return receipt
