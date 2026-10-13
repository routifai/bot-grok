"""Tests for the ``memory/`` folder: journal lines, ``STATE.md``, rebuild from stored checkpoints.

No server and no model: the items route is a small in-memory fake.
"""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any

import pytest

from omnigent.context.rollover import SIDE_CHAT_SEED_HEADER, checkpoint_header
from omnigent.entities import CompactionData
from omnigent.runner.memory import files
from omnigent.runner.memory.sync import rebuild, rebuild_if_missing, record_checkpoint
from omnigent.stores.conversation_store import SIDE_CHAT_LABEL_KEY, SIDE_CHAT_PARENT_LABEL_KEY
from omnigent.superchat.lineage import FORK_ANCHOR_LABEL_KEY

MAIN = files.Origin("main", "conv_main")
SIDE = files.Origin("side", "conv_side", 'Deck "feedback"')
FORK = files.Origin("fork", "conv_fork", "venue line")
STATE_TEXT = "## Working list\n- [t-launch · 2026-10-09] Spring launch budget"
SUMMARY = f"{checkpoint_header('size')}\n\n{STATE_TEXT}"


def _journal(workspace: Path, day: str) -> str:
    return (workspace / "memory" / "journal" / f"{day}.md").read_text(encoding="utf-8")


def _item(
    summary: str = SUMMARY,
    *,
    journal: list[str] | None = None,
    evicted: list[str] | None = None,
) -> CompactionData:
    return CompactionData(
        summary=summary,
        last_item_id="msg_1",
        token_count=1,
        journal_lines=journal,
        evicted_entries=evicted,
    )


# ── lines ────────────────────────────────────────────────────────────────


def test_lines_go_under_the_heading_with_origin_and_chat_id(tmp_path: Path) -> None:
    entries = files.checkpoint_lines(
        MAIN, ["2026-10-09 · Asked for the budget"], None, default_date="2026-10-12"
    )
    assert files.append_lines(tmp_path, entries)

    text = _journal(tmp_path, "2026-10-09")
    assert text == (
        "# 2026-10-09\n\n## Journal\n\n"
        "- 2026-10-09 · Asked for the budget · main <!-- conv_main -->\n"
    )


def test_a_line_without_a_date_gets_the_default_date(tmp_path: Path) -> None:
    entries = files.checkpoint_lines(MAIN, ["Wrote the memo"], None, default_date="2026-10-12")
    files.append_lines(tmp_path, entries)

    assert "- 2026-10-12 · Wrote the memo · main <!-- conv_main -->" in _journal(
        tmp_path, "2026-10-12"
    )


def test_side_and_fork_lines_name_their_chat() -> None:
    side = files.format_line("2026-10-12", "Did a thing", SIDE)[1]
    fork = files.format_line("2026-10-12", "Did a thing", FORK)[1]

    assert side == "- 2026-10-12 · Did a thing · side \"Deck 'feedback'\" <!-- conv_side -->"
    assert fork == '- 2026-10-12 · Did a thing · fork @ "venue line" <!-- conv_fork -->'


def test_a_line_cannot_end_the_trailing_comment() -> None:
    line = files.format_line("2026-10-12", "a --> b\nc", MAIN)[1]

    assert line.count("-->") == 1
    assert "\n" not in line


def test_evicted_entries_are_kept_word_for_word_and_marked() -> None:
    entry = "- [t-old · 2026-08-01] Old plan: keep the 4 sites"
    lines = files.checkpoint_lines(MAIN, None, [entry], default_date="2026-10-12")

    assert lines == [
        (
            "2026-10-12",
            "- 2026-10-12 · Moved out of the working list: "
            "[t-old · 2026-08-01] Old plan: keep the 4 sites · main <!-- conv_main -->",
        )
    ]


def test_two_appends_in_a_row_keep_both(tmp_path: Path) -> None:
    files.append_lines(tmp_path, [files.format_line("2026-10-12", "first", MAIN)])
    files.append_lines(tmp_path, [files.format_line("2026-10-12", "second", SIDE)])

    text = _journal(tmp_path, "2026-10-12")
    assert text.index("first") < text.index("second")
    assert text.count("## Journal") == 1


def test_concurrent_appends_keep_every_line(tmp_path: Path) -> None:
    def write(n: int) -> None:
        files.append_lines(tmp_path, [files.format_line("2026-10-12", f"line {n}", MAIN)])

    threads = [threading.Thread(target=write, args=(n,)) for n in range(30)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    text = _journal(tmp_path, "2026-10-12")
    assert text.count("## Journal") == 1
    assert sum(f"line {n} ·" in text for n in range(30)) == 30


def test_a_later_section_stays_below_new_lines(tmp_path: Path) -> None:
    files.append_lines(tmp_path, [files.format_line("2026-10-12", "first", MAIN)])
    path = tmp_path / "memory" / "journal" / "2026-10-12.md"
    path.write_text(path.read_text() + "\n## Notes\n\nwritten by another section\n")

    files.append_lines(tmp_path, [files.format_line("2026-10-12", "second", MAIN)])

    text = path.read_text()
    assert text.index("first") < text.index("second") < text.index("## Notes")
    assert text.endswith("written by another section\n")


def test_a_failing_write_does_not_raise(tmp_path: Path) -> None:
    blocker = tmp_path / "memory"
    blocker.write_text("a file where the folder should be")

    assert files.append_lines(tmp_path, [files.format_line("2026-10-12", "x", MAIN)]) is False
    assert files.write_state(tmp_path, "state") is False


def test_helper_result_line_has_no_body() -> None:
    date, line = files.helper_result_line(
        MAIN, title="Counting words", outcome="completed", session_id="conv_h1", date="2026-10-12"
    )

    assert date == "2026-10-12"
    assert line == (
        '- 2026-10-12 · Helper "Counting words" completed (session conv_h1) '
        "· main <!-- conv_main -->"
    )


# ── STATE.md ─────────────────────────────────────────────────────────────


def test_state_file_is_the_state_text_under_a_note(tmp_path: Path) -> None:
    assert files.write_state(tmp_path, files.state_text_of(SUMMARY))

    text = (tmp_path / "memory" / "STATE.md").read_text(encoding="utf-8")
    assert text == f"{files.STATE_NOTE}\n\n{STATE_TEXT}\n"
    assert "Context checkpoint" not in text


# ── a stored checkpoint ──────────────────────────────────────────────────


class _Server:
    """Answers the session snapshot and records nothing else."""

    def __init__(self, title: str = "Deck feedback") -> None:
        self._title = title

    async def get(self, url: str, **_kwargs: Any) -> Any:
        title = self._title

        class _Resp:
            status_code = 200

            def json(self) -> dict[str, Any]:
                return {"title": title}

        return _Resp()


@pytest.mark.asyncio
async def test_main_checkpoint_writes_journal_and_state(tmp_path: Path) -> None:
    item = _item(journal=["2026-10-12 · Planned the launch"], evicted=["- [t-x · 2026-07-01] old"])

    await record_checkpoint(_Server(), "conv_main", {}, item, workspace=tmp_path)

    text = _journal(tmp_path, "2026-10-12")
    assert "Planned the launch · main <!-- conv_main -->" in text
    assert "Moved out of the working list: [t-x · 2026-07-01] old" in _journal(
        tmp_path, files.today()
    )
    assert STATE_TEXT in (tmp_path / "memory" / "STATE.md").read_text()


@pytest.mark.asyncio
async def test_side_checkpoint_journals_but_leaves_state_alone(tmp_path: Path) -> None:
    labels = {SIDE_CHAT_LABEL_KEY: "1", SIDE_CHAT_PARENT_LABEL_KEY: "conv_main"}

    await record_checkpoint(
        _Server(),
        "conv_side",
        labels,
        _item(journal=["2026-10-12 · Side work"]),
        workspace=tmp_path,
    )

    assert 'Side work · side "Deck feedback" <!-- conv_side -->' in _journal(
        tmp_path, "2026-10-12"
    )
    assert not (tmp_path / "memory" / "STATE.md").exists()


@pytest.mark.asyncio
async def test_fork_checkpoint_names_the_fork(tmp_path: Path) -> None:
    labels = {
        SIDE_CHAT_LABEL_KEY: "1",
        SIDE_CHAT_PARENT_LABEL_KEY: "conv_main",
        FORK_ANCHOR_LABEL_KEY: "msg_9",
    }

    await record_checkpoint(
        _Server("venue line"),
        "conv_fork",
        labels,
        _item(journal=["2026-10-12 · Forked work"]),
        workspace=tmp_path,
    )

    assert 'fork @ "venue line"' in _journal(tmp_path, "2026-10-12")


@pytest.mark.asyncio
async def test_a_helper_writes_nothing(tmp_path: Path) -> None:
    labels = {"omnigent.context.mode": "superside-chat", "omnigent.subagent": "1"}

    await record_checkpoint(
        _Server(), "conv_h", labels, _item(journal=["2026-10-12 · x"]), workspace=tmp_path
    )

    assert not (tmp_path / "memory").exists()


@pytest.mark.asyncio
async def test_a_failing_snapshot_still_writes(tmp_path: Path) -> None:
    class _Down:
        async def get(self, *_a: Any, **_k: Any) -> Any:
            raise RuntimeError("server down")

    await record_checkpoint(
        _Down(), "conv_main", {}, _item(journal=["2026-10-12 · Kept going"]), workspace=tmp_path
    )

    assert "Kept going" in _journal(tmp_path, "2026-10-12")


# ── rebuild ──────────────────────────────────────────────────────────────

DAY = 1_791_800_000  # 2026-10-12 UTC


def _stored(item_id: str, summary: str, **extra: Any) -> dict[str, Any]:
    return {
        "id": item_id,
        "type": "compaction",
        "created_at": DAY,
        "summary": summary,
        "response_id": f"compact_{item_id}",
        **extra,
    }


class _Chats:
    """The routes a rebuild reads: snapshot, related chats and compaction items."""

    def __init__(self, items: dict[str, list[dict[str, Any]]]) -> None:
        self._items = items

    async def get(self, url: str, **kwargs: Any) -> Any:
        body: dict[str, Any] = {}
        if url.endswith("/related_chats"):
            body = {
                "data": [
                    {"id": "conv_side", "title": "Deck", "anchor_item_id": None},
                    {"id": "conv_fork", "title": "venue line", "anchor_item_id": "msg_9"},
                ]
            }
        elif url.endswith("/items"):
            chat = url.split("/")[3]
            rows = self._items.get(chat, [])
            after = (kwargs.get("params") or {}).get("after")
            if after:
                ids = [r["id"] for r in rows]
                rows = rows[ids.index(after) + 1 :]
            body = {"data": rows[:1], "has_more": len(rows) > 1}
        else:
            body = {"title": "t", "labels": {}}

        class _Resp:
            status_code = 200

            def json(self) -> dict[str, Any]:
                return body

        return _Resp()


def _chats() -> _Chats:
    seed = _stored("c_seed", f"{SIDE_CHAT_SEED_HEADER}\n\nseed state")
    return _Chats(
        {
            "conv_main": [
                _stored("c1", SUMMARY, journal_lines=["2026-10-11 · Asked for a budget"]),
                _stored(
                    "c2",
                    SUMMARY,
                    journal_lines=["2026-10-12 · Booked the venue"],
                    evicted_entries=["- [t-old · 2026-07-01] Old plan"],
                ),
            ],
            "conv_side": [seed, _stored("c3", SUMMARY, journal_lines=["2026-10-12 · Side step"])],
            "conv_fork": [],
        }
    )


@pytest.mark.asyncio
async def test_rebuild_regenerates_the_files_from_stored_checkpoints(tmp_path: Path) -> None:
    await rebuild(_chats(), "conv_main", workspace=tmp_path)

    first = _journal(tmp_path, "2026-10-11")
    second = _journal(tmp_path, "2026-10-12")
    assert "Asked for a budget · main <!-- conv_main -->" in first
    assert "Booked the venue · main" in second
    assert "Moved out of the working list: [t-old · 2026-07-01] Old plan" in second
    assert 'Side step · side "Deck" <!-- conv_side -->' in second
    assert "seed state" not in second
    assert STATE_TEXT in (tmp_path / "memory" / "STATE.md").read_text()


@pytest.mark.asyncio
async def test_rebuild_twice_gives_the_same_files(tmp_path: Path) -> None:
    await rebuild(_chats(), "conv_main", workspace=tmp_path)
    before = {p.name: p.read_text() for p in (tmp_path / "memory").rglob("*.md")}

    await rebuild(_chats(), "conv_main", workspace=tmp_path)

    after = {p.name: p.read_text() for p in (tmp_path / "memory").rglob("*.md")}
    assert after == before


@pytest.mark.asyncio
async def test_rebuild_keeps_lines_that_exist_only_in_the_files(tmp_path: Path) -> None:
    files.append_lines(tmp_path, [files.format_line("2026-10-12", "Helper line", MAIN)])

    await rebuild(_chats(), "conv_main", workspace=tmp_path)

    assert "Helper line" in _journal(tmp_path, "2026-10-12")


@pytest.mark.asyncio
async def test_a_failed_read_leaves_no_folder_so_a_later_turn_retries(tmp_path: Path) -> None:
    class _Down:
        async def get(self, *_a: Any, **_k: Any) -> Any:
            raise RuntimeError("server down")

    await rebuild(_Down(), "conv_main", workspace=tmp_path)

    assert not (tmp_path / "memory").exists()


@pytest.mark.asyncio
async def test_rebuild_if_missing_runs_only_without_a_folder(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("SUPERCHAT_KNOWLEDGE_ROOT", str(tmp_path))
    await rebuild_if_missing(_chats(), "conv_main")
    assert (tmp_path / "memory" / "STATE.md").exists()

    (tmp_path / "memory" / "STATE.md").unlink()
    await rebuild_if_missing(_chats(), "conv_main")
    assert not (tmp_path / "memory" / "STATE.md").exists()
