"""Tests for the sandbox recording capability (offline: a fake exec stands in for the sandbox)."""

from __future__ import annotations

import base64
import json

import click
import pytest

from omnigent.onboarding.sandboxes.base import RemoteCommandResult
from omnigent.onboarding.sandboxes.recording import RecordingMixin

REC = "abcdef012345"


class FakeSandbox(RecordingMixin):
    def __init__(self, replies: dict[str, RemoteCommandResult]) -> None:
        self.replies = replies
        self.commands: list[str] = []

    def run(self, sandbox_id, command, *, check=True, env=None):
        self.commands.append(command)
        for prefix, reply in self.replies.items():
            if command.startswith(prefix):
                return reply
        return RemoteCommandResult(returncode=0, stdout=json.dumps({"ok": True}), stderr="")


def _json(body: dict) -> RemoteCommandResult:
    return RemoteCommandResult(returncode=0, stdout=json.dumps(body) + "\n", stderr="")


def test_start_failure_surfaces_the_helper_error() -> None:
    box = FakeSandbox({"aiden-recorder start": _json({"ok": False, "error": "no browser"})})
    with pytest.raises(click.ClickException, match="no browser"):
        box.start_recording("sb", REC)


def test_stop_returns_trace_with_only_available_keyframes_then_discards() -> None:
    pulled = {
        "ok": True,
        "actions": [
            {"seq": 1, "kind": "navigate", "keyframe": "k1"},
            {"seq": 2, "kind": "click", "keyframe": "k2"},
            {"seq": 3, "kind": "secret"},
        ],
        "keyframes": ["k1"],
    }
    box = FakeSandbox(
        {
            "aiden-recorder pull": _json(pulled),
            f"aiden-recorder frame {REC} k1": RemoteCommandResult(
                0, base64.b64encode(b"jpeg").decode() + "\n", ""
            ),
        }
    )
    trace = box.stop_recording("sb", REC)
    assert trace.keyframes == {"k1": b"jpeg"}
    assert [a.get("keyframe") for a in trace.actions] == ["k1", None, None]
    assert box.commands[0].startswith("aiden-recorder stop")
    assert box.commands[-1] == f"aiden-recorder discard {REC}"


def test_stop_discards_even_when_the_trace_cannot_be_read() -> None:
    box = FakeSandbox({"aiden-recorder pull": _json({"ok": False, "error": "gone"})})
    with pytest.raises(click.ClickException):
        box.stop_recording("sb", REC)
    assert box.commands[-1] == f"aiden-recorder discard {REC}"


def test_rejects_ids_that_could_inject_shell() -> None:
    box = FakeSandbox({})
    with pytest.raises(click.ClickException, match="invalid"):
        box.start_recording("sb", "x; rm -rf /")
    assert box.commands == []
