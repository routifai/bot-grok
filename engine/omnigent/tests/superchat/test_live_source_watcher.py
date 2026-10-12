"""The Computer's poll of live page sources."""

from __future__ import annotations

import contextlib
import json
import os
from pathlib import Path

import httpx

from omnigent.runner.live.watcher import SourceWatcher


def _watcher(tmp_path: Path, paths: list[str], posted: list[list[str]]) -> SourceWatcher:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer host:tok"
        if request.url.path == "/v1/live/watch":
            return httpx.Response(200, json={"paths": paths})
        posted.append(json.loads(request.content)["paths"])
        return httpx.Response(202, json={"pages": 1})

    return SourceWatcher(
        lambda: "http://engine", lambda: "host:tok", tmp_path,
        transport=httpx.MockTransport(handler),
    )  # fmt: skip


def _touch(path: Path, text: str, mtime: int) -> None:
    path.write_text(text)
    os.utime(path, ns=(mtime, mtime))


def test_first_look_records_then_only_a_changed_file_is_reported(tmp_path: Path) -> None:
    posted: list[list[str]] = []
    watcher = _watcher(tmp_path, ["tea.csv", "gone.csv"], posted)
    _touch(tmp_path / "tea.csv", "a", 1_000_000_000)
    assert watcher.poll() == [] and posted == []  # a restart starts nothing
    assert watcher.poll() == []
    _touch(tmp_path / "tea.csv", "b", 2_000_000_000)
    assert watcher.poll() == ["tea.csv"] and posted == [["tea.csv"]]
    assert watcher.poll() == []  # reported once
    _touch(tmp_path / "gone.csv", "x", 3_000_000_000)  # appeared after the first look
    assert watcher.poll() == ["gone.csv"]


def test_a_failed_report_is_sent_again_next_pass(tmp_path: Path) -> None:
    posted: list[list[str]] = []
    watcher = _watcher(tmp_path, ["tea.csv"], posted)
    _touch(tmp_path / "tea.csv", "a", 1_000_000_000)
    watcher.poll()
    _touch(tmp_path / "tea.csv", "b", 2_000_000_000)
    watcher._transport = httpx.MockTransport(lambda r: httpx.Response(500))
    with contextlib.suppress(httpx.HTTPStatusError):
        watcher.poll()
    watcher._transport = _watcher(tmp_path, ["tea.csv"], posted)._transport
    assert watcher.poll() == ["tea.csv"]
