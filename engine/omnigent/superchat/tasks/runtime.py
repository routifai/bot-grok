"""Runner side of tasks: the turn's task lines, the events tools report, the stall count.

* :func:`message_prefix` reads the Conversation's active tasks and writes one line each in front
  of the person's message, after "They picked ..." when the message answers a card.
* :func:`on_result` reports what a tool did (``deck_new``, ``artifact_save``, ``start_helper``) to
  the server, in order per session, and notes that the turn acted.
* :func:`turn_ended` logs a **stall**: a turn that began with an active task and ended without a
  saved file, a question card or a started Helper. It only counts; it changes nothing.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from collections.abc import Sequence
from typing import TYPE_CHECKING, Any

import httpx

from omnigent.superchat.tasks.record import CardAnswer, Task, prefix_lines

if TYPE_CHECKING:
    from omnigent.superchat.feature import HandlerCtx

_logger = logging.getLogger(__name__)

SAVE, ASK, HELPER, DECK = "artifact_save", "ask_clarification", "start_helper", "deck_new"
#: The tools that end a turn on a task well: a deliverable, a question, a started Helper.
TURN_ENDINGS = frozenset({SAVE, ASK, HELPER})
_TIMEOUT = 10.0

#: ``Conversation id -> the active task's id`` for a turn that has not acted yet.
_watching: dict[str, str] = {}
#: ``session id -> the last event post``, so a session's events reach the server in order.
_posts: dict[str, asyncio.Task[None]] = {}


class _Stalls:
    """The stall counter (process-wide)."""

    count = 0


STALLS = _Stalls()


async def read_tasks(client: httpx.AsyncClient | None, session_id: str | None) -> dict | None:
    """The server's task view of *session_id* (:meth:`TaskService.view`), or ``None``."""
    if client is None or not session_id:
        return None
    try:
        resp = await client.get(f"/v1/sessions/{session_id}/tasks", timeout=_TIMEOUT)
        view = resp.json() if resp.status_code == 200 else None
    except (httpx.HTTPError, ValueError):
        return None
    return view if isinstance(view, dict) else None


def _tasks(view: dict[str, Any]) -> list[Task]:
    out: list[Task] = []
    for raw in view.get("tasks") or ():
        if not isinstance(raw, dict) or not isinstance(raw.get("id"), str):
            continue
        out.append(
            Task(
                id=raw["id"],
                owner="",
                conversation_id=str(view.get("conversation_id") or ""),
                kind=str(raw.get("kind") or "file"),
                title=str(raw.get("title") or ""),
                fields=raw.get("fields") if isinstance(raw.get("fields"), dict) else {},
                status=str(raw.get("status") or "open"),
                helper_ids=[str(h) for h in raw.get("helper_ids") or ()],
            )
        )
    return out


def _answer(view: dict[str, Any]) -> CardAnswer | None:
    raw = view.get("answer")
    if not isinstance(raw, dict):
        return None
    try:
        return CardAnswer(str(raw["card_id"]), str(raw["option_id"]), str(raw["label"]))
    except KeyError:
        return None


async def message_prefix(
    client: httpx.AsyncClient | None, conversation_id: str, _texts: Sequence[str]
) -> list[str]:
    """The pick (when the message answers a card) and one line per active task, as one block.

    Only the Conversation itself gets them (a Helper works from its Brief), and only there a
    turn is watched for a stall.
    """
    _watching.pop(conversation_id, None)
    view = await read_tasks(client, conversation_id)
    if view is None or view.get("is_helper") or view.get("conversation_id") != conversation_id:
        return []
    tasks = _tasks(view)
    if tasks:
        _watching[conversation_id] = tasks[0].id
    lines = prefix_lines(tasks, _answer(view))
    return ["\n".join(lines)] if lines else []


def _ok(output: str) -> dict[str, Any] | None:
    """A tool's JSON result when it succeeded, else ``None``."""
    try:
        data = json.loads(output)
    except ValueError:
        return None
    if not isinstance(data, dict) or "error" in data:
        return None
    return data


def _event(tool: str, data: dict[str, Any]) -> dict[str, Any] | None:
    """The task event a successful tool result reports, if any."""
    if tool == DECK and isinstance(data.get("deck"), dict):
        return {"event": DECK, **data["deck"], "written": data.get("written") is True}
    if tool == SAVE and data.get("type") == "artifact":
        return {
            "event": SAVE,
            "name": data.get("name"),
            "title": data.get("title"),
            "group_id": data.get("group_id") or data.get("id"),
        }
    if tool == HELPER and data.get("started") is True:
        return {"event": HELPER, "helper_id": data.get("helper_id")}
    return None


def _post(client: httpx.AsyncClient, session_id: str, body: dict[str, Any]) -> None:
    """Send *body* after this session's earlier events (``on_result`` cannot await)."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    before = _posts.get(session_id)

    async def send() -> None:
        if before is not None:
            with contextlib.suppress(Exception):
                await before
        try:
            resp = await client.post(
                f"/v1/sessions/{session_id}/tasks/events", json=body, timeout=_TIMEOUT
            )
            if resp.status_code >= 400:
                _logger.info("task event %s refused: %s", body["event"], resp.status_code)
        except httpx.HTTPError:
            _logger.info("task event %s not sent", body["event"], exc_info=True)

    task = loop.create_task(send())
    _posts[session_id] = task
    task.add_done_callback(
        lambda t: _posts.pop(session_id, None) if _posts.get(session_id) is t else None
    )


async def flush(session_id: str) -> None:
    """Wait for this session's events to reach the server (tests, and a clean shutdown)."""
    pending = _posts.get(session_id)
    if pending is not None:
        await pending


def on_result(ctx: HandlerCtx, output: str) -> None:
    """A feature tool ran: report its task event and note a turn ending."""
    session_id = ctx.conversation_id
    if not session_id:
        return
    tool = ctx.tool_name
    data = _ok(output) if tool in (DECK, *TURN_ENDINGS) else None
    if data is None:
        return
    if tool in TURN_ENDINGS:
        _watching.pop(session_id, None)
    event = _event(tool, data)
    if event is not None and ctx.server_client is not None:
        _post(ctx.server_client, session_id, event)


def turn_ended(session_id: str) -> None:
    """Log a stall when this turn began on an active task and ended without acting on it."""
    task_id = _watching.pop(session_id, None)
    if task_id is None:
        return
    STALLS.count += 1
    _logger.info("stall for %s on task %s", session_id, task_id, extra={"session_id": session_id})
