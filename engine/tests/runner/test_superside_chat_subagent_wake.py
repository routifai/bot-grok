"""Tests for the superside-chat sub-agent wake (slice S3).

On top of the plain-mode wake (``[System: ... waiting in inbox]``, covered by
``test_stranded_wake_retry_on_reconnect.py``), a ``superside_chat`` work entry's
wake notice inlines the sub-agent's Result itself instead of only announcing
"N results waiting".
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import httpx
import pytest

from omnigent.runner import create_runner_app
from tests.runner.conftest import _FakeProcessManager, _runner_client, _ScriptedHarnessClient
from tests.runner.helpers import NullServerClient


class _RecordingServerClient(NullServerClient):
    """Fake server client: serves fixed session snapshots, records every POST."""

    def __init__(self, *, snapshots: dict[str, dict[str, Any]] | None = None) -> None:
        self._snapshots = snapshots or {}
        self.posts: list[tuple[str, dict[str, Any]]] = []

    async def get(self, url: str, **kwargs: Any) -> Any:
        for session_id, snapshot in self._snapshots.items():
            if url == f"/v1/sessions/{session_id}":
                request = httpx.Request("GET", f"http://runner.test{url}")
                return httpx.Response(200, request=request, json=snapshot)
        return await super().get(url, **kwargs)

    async def post(self, url: str, **kwargs: Any) -> Any:
        body = kwargs.get("json")
        if isinstance(body, dict):
            self.posts.append((url, body))
        request = httpx.Request("POST", f"http://runner.test{url}")
        return httpx.Response(200, request=request, json={})


def _complete_child(app: Any, child_id: str, output: str) -> None:
    """End the child's work as the runner does when a Helper's last turn completes."""
    app.state.mark_subagent_terminal_and_wake(child_id, status="completed", output=output)


def _notice_text(post: tuple[str, dict[str, Any]]) -> str:
    _url, body = post
    content = body["data"]["content"]
    return str(content[0]["text"])


@pytest.mark.asyncio
async def test_superside_chat_wake_inlines_result(_no_wake_backoff: list[float]) -> None:
    """A ``superside_chat`` entry's wake carries the Result, not 'waiting in inbox'."""
    from omnigent.runner import app as runner_app

    parent_id = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4"
    child_id = "b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5"
    session_inbox: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
    server_client = _RecordingServerClient()
    pm = _FakeProcessManager(_ScriptedHarnessClient([]))
    app = create_runner_app(
        process_manager=pm,  # type: ignore[arg-type]
        server_client=server_client,  # type: ignore[arg-type]
    )

    runner_app._session_inboxes_ref[parent_id] = session_inbox
    runner_app.register_subagent_work(
        parent_session_id=parent_id,
        child_session_id=child_id,
        agent="reviewer",
        title="auth",
        superside_chat=True,
    )
    try:
        async with _runner_client(app):
            _complete_child(app, child_id, "FINDINGS: the vault key rotated on March 3.")
            deadline = asyncio.get_running_loop().time() + 5.0
            while not server_client.posts:
                if asyncio.get_running_loop().time() > deadline:
                    raise AssertionError("no wake POST observed within 5s")
                await asyncio.sleep(0.01)

        assert len(server_client.posts) == 1
        url, body = server_client.posts[0]
        assert url == f"/v1/sessions/{parent_id}/events"
        # Marked structurally, so nothing downstream sniffs the text to tell it from the person.
        assert body["data"]["is_system_notice"] is True
        text = _notice_text(server_client.posts[0])
        assert "FINDINGS: the vault key rotated on March 3." in text
        assert "waiting in inbox" not in text

        entry = runner_app.get_subagent_work(child_id)
        assert entry is not None
        assert entry.wake_inlined is True
    finally:
        runner_app.unregister_subagent_work(child_id)
        runner_app._session_inboxes_ref.pop(parent_id, None)


@pytest.mark.asyncio
async def test_a_delivered_helper_result_adds_one_journal_line(
    _no_wake_backoff: list[float], _isolated_knowledge_workspace: Path
) -> None:
    """The line names the Helper, its outcome and session id, never the Result text."""
    from omnigent.runner import app as runner_app

    parent_id = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4"
    child_id = "b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5"
    server_client = _RecordingServerClient()
    app = create_runner_app(
        process_manager=_FakeProcessManager(_ScriptedHarnessClient([])),  # type: ignore[arg-type]
        server_client=server_client,  # type: ignore[arg-type]
    )
    runner_app._session_inboxes_ref[parent_id] = asyncio.Queue()
    runner_app.register_subagent_work(
        parent_session_id=parent_id,
        child_session_id=child_id,
        agent="reviewer",
        title="auth",
        superside_chat=True,
    )
    journal_dir = _isolated_knowledge_workspace / "memory" / "journal"
    try:
        async with _runner_client(app):
            _complete_child(app, child_id, "FINDINGS: the vault key rotated on March 3.")
            deadline = asyncio.get_running_loop().time() + 5.0
            while not list(journal_dir.glob("*.md")):
                if asyncio.get_running_loop().time() > deadline:
                    raise AssertionError("no journal line within 5s")
                await asyncio.sleep(0.01)

        (day_file,) = journal_dir.glob("*.md")
        lines = [ln for ln in day_file.read_text().splitlines() if ln.startswith("- ")]
        assert len(lines) == 1
        assert f'Helper "auth" completed (session {child_id})' in lines[0]
        assert f"main <!-- {parent_id} helpers:{child_id} -->" in lines[0]
        assert "vault key" not in lines[0]
    finally:
        runner_app.unregister_subagent_work(child_id)
        runner_app._session_inboxes_ref.pop(parent_id, None)


@pytest.mark.asyncio
async def test_plain_mode_wake_is_unchanged(_no_wake_backoff: list[float]) -> None:
    """A non-superside-chat entry keeps the plain 'N results waiting' notice."""
    from omnigent.runner import app as runner_app

    parent_id = "c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6"
    child_id = "d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1"
    session_inbox: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
    server_client = _RecordingServerClient()
    pm = _FakeProcessManager(_ScriptedHarnessClient([]))
    app = create_runner_app(
        process_manager=pm,  # type: ignore[arg-type]
        server_client=server_client,  # type: ignore[arg-type]
    )

    runner_app._session_inboxes_ref[parent_id] = session_inbox
    runner_app.register_subagent_work(
        parent_session_id=parent_id,
        child_session_id=child_id,
        agent="reviewer",
        title="auth",
    )
    try:
        async with _runner_client(app):
            _complete_child(app, child_id, "FINDINGS: should not be inlined.")
            deadline = asyncio.get_running_loop().time() + 5.0
            while not server_client.posts:
                if asyncio.get_running_loop().time() > deadline:
                    raise AssertionError("no wake POST observed within 5s")
                await asyncio.sleep(0.01)

        text = _notice_text(server_client.posts[0])
        assert "waiting in inbox" in text
        assert "FINDINGS: should not be inlined." not in text

        entry = runner_app.get_subagent_work(child_id)
        assert entry is not None
        assert entry.wake_inlined is False
    finally:
        runner_app.unregister_subagent_work(child_id)
        runner_app._session_inboxes_ref.pop(parent_id, None)
