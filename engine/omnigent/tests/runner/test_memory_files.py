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
from omnigent.runner.memory.sync import (
    rebuild,
    rebuild_if_missing,
    reconcile,
    record_checkpoint,
    record_daily_note,
)
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
        "· main <!-- conv_main helpers:conv_h1 -->"
    )


def test_helper_result_line_names_its_project_when_known() -> None:
    line = files.helper_result_line(
        MAIN,
        title="Counting words",
        outcome="completed",
        session_id="conv_h1",
        date="2026-10-12",
        project="spring-launch",
    )[1]

    assert line.endswith("· main <!-- conv_main project:spring-launch helpers:conv_h1 -->")


REFS = {"files": ["projects/spring-launch/budget.xlsx"], "artifacts": ["a1@v3"]}


def test_journal_lines_carry_the_refs_after_the_chat_id() -> None:
    lines = files.checkpoint_lines(
        MAIN,
        ["2026-10-12 · Checked the quote", "2026-10-12 · Saved the budget"],
        ["- [t-old · 2026-08-01] Old plan"],
        default_date="2026-10-12",
        refs=REFS,
    )

    suffix = " · main <!-- conv_main files:projects/spring-launch/budget.xlsx artifacts:a1@v3 -->"
    assert lines[0][1] == "- 2026-10-12 · Checked the quote" + suffix
    assert lines[1][1].endswith(suffix)
    # An evicted entry is the state file's text, not this window's work.
    assert lines[2][1].endswith("· main <!-- conv_main -->")


def test_refs_cannot_end_the_trailing_comment() -> None:
    line = files.format_line("2026-10-12", "x", MAIN, {"files": ["a-->b c.md"]})[1]

    assert line.endswith("<!-- conv_main files:a--%3Eb%20c.md -->")
    assert line.count("-->") == 1


def test_an_old_checkpoint_without_refs_still_loads() -> None:
    item = CompactionData.model_validate(
        {"summary": SUMMARY, "last_item_id": "m", "token_count": 1, "journal_lines": ["x"]}
    )

    assert item.journal_refs is None


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
async def test_rebuild_writes_the_refs_exactly_as_the_checkpoint_did(tmp_path: Path) -> None:
    item = CompactionData(
        summary=SUMMARY,
        last_item_id="msg_1",
        token_count=1,
        journal_lines=["2026-10-12 · Checked the quote"],
        journal_refs=REFS,
    )
    live, rebuilt = tmp_path / "live", tmp_path / "rebuilt"
    await record_checkpoint(_Server(), "conv_main", {}, item, workspace=live)
    stored = _stored("c1", SUMMARY, **item.model_dump(exclude={"summary"}))

    await rebuild(_Chats({"conv_main": [stored]}), "conv_main", workspace=rebuilt)

    assert "files:projects/spring-launch/budget.xlsx artifacts:a1@v3 -->" in _journal(
        live, "2026-10-12"
    )
    assert _journal(rebuilt, "2026-10-12") == _journal(live, "2026-10-12")


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


# ── daily note sections in the day file ──────────────────────────────────

NOTE = {
    "talked_about": "Launch budget",
    "decisions": "Book the venue",
    "promised": "",
    "open_loops": "Pick a caterer",
    "reflection": "A calm day.",
}


def _day(workspace: Path) -> Path:
    return workspace / "memory" / "journal" / "2026-10-12.md"


def test_a_note_projects_notes_and_reflection_and_leaves_the_journal_alone(tmp_path: Path) -> None:
    files.append_lines(tmp_path, [files.format_line("2026-10-12", "Planned", MAIN)])
    before = [ln for ln in _day(tmp_path).read_text().splitlines() if ln.startswith("- ")]

    assert files.write_day_sections(tmp_path, "2026-10-12", NOTE)

    text = _day(tmp_path).read_text()
    assert [ln for ln in text.splitlines() if ln.startswith("- ")] == before
    assert "## Notes\n\n### What we talked about\nLaunch budget" in text
    assert "### Decisions\nBook the venue" in text
    assert "### Promised" not in text
    assert "## Reflection\n\nA calm day." in text
    assert text.index("## Journal") < text.index("## Notes") < text.index("## Reflection")


def test_a_second_projection_replaces_the_sections(tmp_path: Path) -> None:
    files.write_day_sections(tmp_path, "2026-10-12", NOTE)

    files.write_day_sections(tmp_path, "2026-10-12", {**NOTE, "decisions": "Skip the venue"})

    text = _day(tmp_path).read_text()
    assert text.count("## Notes") == 1
    assert text.count("## Reflection") == 1
    assert "Skip the venue" in text
    assert "Book the venue" not in text


def test_journal_appends_after_a_projection_stay_in_the_journal(tmp_path: Path) -> None:
    files.append_lines(tmp_path, [files.format_line("2026-10-12", "first", MAIN)])
    files.write_day_sections(tmp_path, "2026-10-12", NOTE)

    files.append_lines(tmp_path, [files.format_line("2026-10-12", "second", MAIN)])

    text = _day(tmp_path).read_text()
    assert text.index("first") < text.index("second") < text.index("## Notes")


def test_a_projection_into_a_new_day_still_leaves_room_for_the_journal(tmp_path: Path) -> None:
    files.write_day_sections(tmp_path, "2026-10-12", NOTE)

    files.append_lines(tmp_path, [files.format_line("2026-10-12", "late", MAIN)])

    text = _day(tmp_path).read_text()
    assert text.index("## Journal") < text.index("late") < text.index("## Notes")


def test_an_empty_note_writes_no_section(tmp_path: Path) -> None:
    empty = dict.fromkeys(NOTE, "")
    files.write_day_sections(tmp_path, "2026-10-12", empty)
    assert not _day(tmp_path).exists()

    files.append_lines(tmp_path, [files.format_line("2026-10-12", "line", MAIN)])
    files.write_day_sections(tmp_path, "2026-10-12", empty)
    text = _day(tmp_path).read_text()
    assert "## Notes" not in text
    assert "## Reflection" not in text


def test_note_text_cannot_open_a_section(tmp_path: Path) -> None:
    files.write_day_sections(tmp_path, "2026-10-12", {"decisions": "## Journal\n- fake"})

    lines = _day(tmp_path).read_text().splitlines()
    assert lines.count("## Journal") == 1
    assert "\\## Journal" in lines


def test_a_bad_date_writes_nothing(tmp_path: Path) -> None:
    assert not files.write_day_sections(tmp_path, "../x", NOTE)
    assert not (tmp_path / "memory").exists()


@pytest.mark.asyncio
async def test_record_daily_note_projects_the_response_body(tmp_path: Path) -> None:
    await record_daily_note({"date": "2026-10-12", "sections": NOTE}, workspace=tmp_path)
    await record_daily_note({"nonsense": 1}, workspace=tmp_path)

    assert "A calm day." in _day(tmp_path).read_text()


class _Resp:
    def __init__(self, status: int, body: Any) -> None:
        self.status_code = status
        self._body = body
        self.text = str(body)

    def json(self) -> Any:
        return self._body


class _NoteServer:
    """Answers the caller lookup and the daily note write."""

    def __init__(self, status: int = 200) -> None:
        self._status = status

    async def get(self, url: str, **_kwargs: Any) -> Any:
        return _Resp(200, {"kind": "agent", "parent_session_id": None})

    async def post(self, url: str, **_kwargs: Any) -> Any:
        return _Resp(self._status, {"date": "2026-10-12", "sections": NOTE})


async def _update(server: Any) -> str:
    from omnigent.superchat.daily_notes.handlers import handle_daily_note_tool
    from omnigent.superchat.feature import HandlerCtx

    ctx = HandlerCtx("daily_note_update", server, "conv_main")
    return await handle_daily_note_tool(ctx, {"decisions": "Book the venue"})


@pytest.mark.asyncio
async def test_the_update_tool_projects_into_the_workspace(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("SUPERCHAT_KNOWLEDGE_ROOT", str(tmp_path))

    out = await _update(_NoteServer())

    assert '"date": "2026-10-12"' in out
    assert "Book the venue" in _day(tmp_path).read_text()


@pytest.mark.asyncio
async def test_a_failing_projection_does_not_fail_the_tool_call(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("SUPERCHAT_KNOWLEDGE_ROOT", str(tmp_path))

    def boom(*_a: Any, **_k: Any) -> None:
        raise RuntimeError("disk")

    monkeypatch.setattr(files, "write_day_sections", boom)

    out = await _update(_NoteServer())

    assert '"date": "2026-10-12"' in out


@pytest.mark.asyncio
async def test_a_refused_write_projects_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("SUPERCHAT_KNOWLEDGE_ROOT", str(tmp_path))

    out = await _update(_NoteServer(status=403))

    assert "error" in out
    assert not (tmp_path / "memory").exists()


# ── reset, owner ─────────────────────────────────────────────────────────


def _reset(item_id: str = "c_reset", created_at: int = DAY) -> dict[str, Any]:
    return {
        "id": item_id,
        "type": "compaction",
        "created_at": created_at,
        "summary": "reset",
        "response_id": f"reset_{item_id}",
    }


class _Convo:
    """Snapshot, related chats, newest-first compaction items and notes for a few chats."""

    def __init__(
        self,
        items: dict[str, list[dict[str, Any]]],
        labels: dict[str, dict[str, str]] | None = None,
        notes: list[dict[str, Any]] | None = None,
    ) -> None:
        self._items = items
        self._labels = labels or {}
        self._notes = notes or []
        self.related_reads = 0
        #: Chats the server answers 404 for (deleted).
        self.deleted: set[str] = set()

    async def get(self, url: str, **kwargs: Any) -> Any:
        params = kwargs.get("params") or {}
        body: dict[str, Any]
        if url == "/v1/me/daily-notes":
            body = {"daily_notes": self._notes}
        elif url.endswith("/related_chats"):
            self.related_reads += 1
            body = {"data": []}
        elif url.endswith("/items"):
            rows = list(self._items.get(url.split("/")[3], []))
            if params.get("order") == "desc":
                rows.reverse()
            elif params.get("after"):
                ids = [r["id"] for r in rows]
                rows = rows[ids.index(params["after"]) + 1 :]
            body = {
                "data": rows[: int(params["limit"])]
                if params.get("order") == "desc"
                else rows[:1],
                "has_more": params.get("order") != "desc" and len(rows) > 1,
            }
        else:
            if url.split("/")[3] in self.deleted:
                return _Resp(404, {})
            body = {"title": "t", "labels": self._labels.get(url.split("/")[3], {})}
        return _Resp(200, body)


def _lines(workspace: Path) -> list[str]:
    return [ln for ln in _journal(workspace, "2026-10-12").splitlines() if ln.startswith("- ")]


def _tree(workspace: Path) -> dict[str, str]:
    return {
        str(p.relative_to(workspace)): p.read_text()
        for p in sorted((workspace / "memory").rglob("*"))
        if p.is_file() and p.name != ".lock"
    }


@pytest.mark.asyncio
async def test_a_reset_appends_one_line_and_empties_the_state_once(tmp_path: Path) -> None:
    chats = _Convo({"conv_main": [_stored("c1", SUMMARY), _reset()]})
    await rebuild(_Convo({"conv_main": [_stored("c1", SUMMARY)]}), "conv_main", workspace=tmp_path)
    assert STATE_TEXT in (tmp_path / "memory" / "STATE.md").read_text()

    await reconcile(chats, "conv_main", {}, workspace=tmp_path)
    await reconcile(chats, "conv_main", {}, workspace=tmp_path)

    assert [ln for ln in _lines(tmp_path) if "conversation reset" in ln] == [
        "- 2026-10-12 · conversation reset · main <!-- conv_main -->"
    ]
    state = (tmp_path / "memory" / "STATE.md").read_text()
    assert state == f"{files.STATE_NOTE}\n\nThe conversation was reset on 2026-10-12.\n"
    assert (tmp_path / "memory" / ".last_reset").read_text().strip() == "c_reset"


@pytest.mark.asyncio
async def test_a_second_reset_is_written_again_and_a_checkpoint_is_not_a_reset(
    tmp_path: Path,
) -> None:
    items = {"conv_main": [_stored("c1", SUMMARY), _reset("r1")]}
    await rebuild(_Convo({"conv_main": [_stored("c1", SUMMARY)]}), "conv_main", workspace=tmp_path)
    await reconcile(_Convo(items), "conv_main", {}, workspace=tmp_path)
    items["conv_main"] += [_stored("c2", SUMMARY), _reset("r2", DAY + 86_400)]
    await reconcile(_Convo(items), "conv_main", {}, workspace=tmp_path)
    await reconcile(
        _Convo({"conv_main": [_stored("c3", SUMMARY)]}), "conv_main", {}, workspace=tmp_path
    )

    resets = [
        ln for d in ("2026-10-12", "2026-10-13") for ln in _journal(tmp_path, d).splitlines()
    ]
    assert sum("conversation reset" in ln for ln in resets) == 2
    assert files.last_reset_of(tmp_path) == "r2"


@pytest.mark.asyncio
async def test_rebuild_after_a_reset_gives_the_same_files(tmp_path: Path) -> None:
    items = {
        "conv_main": [
            _stored("c1", SUMMARY, journal_lines=["2026-10-12 · Booked the venue"]),
            _reset(),
        ]
    }
    live, rebuilt = tmp_path / "live", tmp_path / "rebuilt"
    await rebuild(_Convo({"conv_main": items["conv_main"][:1]}), "conv_main", workspace=live)
    await reconcile(_Convo(items), "conv_main", {}, workspace=live)

    await rebuild(_Convo(items), "conv_main", workspace=rebuilt)

    assert _tree(rebuilt) == _tree(live)


@pytest.mark.asyncio
async def test_rebuild_covers_the_stored_daily_notes(tmp_path: Path) -> None:
    chats = _Convo(
        {"conv_main": [_stored("c1", SUMMARY)]},
        notes=[{"date": "2026-10-12", "sections": NOTE}, {"date": "2026-10-11", "sections": {}}],
    )

    await rebuild(chats, "conv_main", workspace=tmp_path)

    assert "Pick a caterer" in _day(tmp_path).read_text()
    assert not (tmp_path / "memory" / "journal" / "2026-10-11.md").exists()


@pytest.mark.asyncio
async def test_a_different_main_conversation_wipes_and_rebuilds(tmp_path: Path) -> None:
    await rebuild(_Convo({"conv_main": [_stored("c1", SUMMARY)]}), "conv_main", workspace=tmp_path)
    files.append_lines(tmp_path, [files.format_line("2026-10-12", "old", MAIN)])
    new = _Convo({"conv_new": [_stored("n1", SUMMARY, journal_lines=["2026-10-12 · New start"])]})

    # While the old Conversation still exists, a second one leaves its folder alone.
    await reconcile(new, "conv_new", {}, workspace=tmp_path)
    assert files.owner_of(tmp_path) == "conv_main"
    assert "old" in _journal(tmp_path, "2026-10-12")

    new.deleted.add("conv_main")
    await reconcile(new, "conv_new", {}, workspace=tmp_path)

    assert files.owner_of(tmp_path) == "conv_new"
    assert "old" not in _journal(tmp_path, "2026-10-12")
    assert "New start" in _journal(tmp_path, "2026-10-12")


@pytest.mark.asyncio
async def test_a_side_chat_or_fork_of_the_same_main_does_not_wipe(tmp_path: Path) -> None:
    await rebuild(_Convo({"conv_main": [_stored("c1", SUMMARY)]}), "conv_main", workspace=tmp_path)
    files.append_lines(tmp_path, [files.format_line("2026-10-12", "keep", MAIN)])
    side = {SIDE_CHAT_LABEL_KEY: "1", SIDE_CHAT_PARENT_LABEL_KEY: "conv_main"}
    fork = {**side, FORK_ANCHOR_LABEL_KEY: "msg_9"}
    chats = _Convo({"conv_main": [_stored("c1", SUMMARY)]})

    await reconcile(chats, "conv_side", side, workspace=tmp_path)
    await reconcile(chats, "conv_fork", fork, workspace=tmp_path)

    assert "keep" in _journal(tmp_path, "2026-10-12")
    assert files.owner_of(tmp_path) == "conv_main"


@pytest.mark.asyncio
async def test_a_folder_without_a_marker_is_adopted(tmp_path: Path) -> None:
    files.append_lines(tmp_path, [files.format_line("2026-10-12", "kept", MAIN)])

    await reconcile(_Convo({"conv_main": []}), "conv_main", {}, workspace=tmp_path)

    assert files.owner_of(tmp_path) == "conv_main"
    assert "kept" in _journal(tmp_path, "2026-10-12")


@pytest.mark.asyncio
async def test_an_unresolved_main_or_a_helper_touches_nothing(tmp_path: Path) -> None:
    await rebuild(_Convo({"conv_main": [_stored("c1", SUMMARY)]}), "conv_main", workspace=tmp_path)
    before = _tree(tmp_path)
    orphan = {SIDE_CHAT_LABEL_KEY: "1"}
    chats = _Convo({"conv_other": [_stored("x", SUMMARY)]})

    await reconcile(chats, "conv_side", orphan, workspace=tmp_path)

    assert _tree(tmp_path) == before
    assert files.owner_of(tmp_path) == "conv_main"


@pytest.mark.asyncio
async def test_a_checkpoint_marks_a_new_folder_with_its_main_conversation(tmp_path: Path) -> None:
    await record_checkpoint(_Server(), "conv_main", {}, _item(), workspace=tmp_path)

    assert files.owner_of(tmp_path) == "conv_main"


# ── the index's conversation source ──────────────────────────────────────


def _say(item_id: str, role: str, text: str, rid: str, **extra: Any) -> dict[str, Any]:
    kind = "input_text" if role == "user" else "output_text"
    return {
        "id": item_id,
        "response_id": rid,
        "type": "message",
        "role": role,
        "created_at": DAY,
        "content": [{"type": kind, "text": text}],
        **extra,
    }


def _turns(prefix: str, count: int) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for n in range(count):
        rows += [
            _say(f"{prefix}u{n}", "user", f"question {n} about the venue", f"{prefix}r{n}"),
            _say(f"{prefix}a{n}", "assistant", f"answer {n}", f"{prefix}r{n}"),
        ]
    return rows


class _Record:
    """The routes the conversation source reads: snapshot, related chats, items (both orders)."""

    def __init__(
        self,
        items: dict[str, list[dict[str, Any]]],
        related: dict[str, list[dict[str, Any]]] | None = None,
    ) -> None:
        self.items = items
        self.related = related or {}
        self.deleted: set[str] = set()
        self.reads: list[tuple[str, dict[str, Any]]] = []

    async def get(self, url: str, **kwargs: Any) -> Any:
        params = dict(kwargs.get("params") or {})
        chat = url.split("/")[3]
        if url.endswith("/related_chats"):
            return _Resp(200, {"data": self.related.get(chat, [])})
        if url.endswith("/items"):
            self.reads.append((chat, params))
            rows = [r for r in self.items.get(chat, []) if params.get("type") in (None, r["type"])]
            if params.get("order") == "desc":
                rows = rows[::-1]
            if params.get("after"):
                ids = [r["id"] for r in rows]
                if params["after"] not in ids:
                    return _Resp(400, {"error": "stale_cursor"})
                rows = rows[ids.index(params["after"]) + 1 :]
            limit = int(params.get("limit", 100))
            return _Resp(200, {"data": rows[:limit], "has_more": len(rows) > limit})
        if chat in self.deleted:
            return _Resp(404, {})
        return _Resp(200, {"title": "t", "labels": {}})

    async def post(self, url: str, **kwargs: Any) -> Any:
        """A stored compaction joins the record (the rollover's ``POST .../events``)."""
        rows = self.items.setdefault(url.split("/")[3], [])
        data = dict(kwargs["json"]["data"])
        rows.append({**data, "id": f"cmp{len(rows)}", "created_at": DAY})
        return _Resp(200, {})


def _service(tmp_path: Path) -> Any:
    from omnigent.runner.knowledge.runtime import KnowledgeRuntime
    from tests.runner.knowledge._fixtures import FakeEmbedder

    return KnowledgeRuntime(tmp_path / "index", tmp_path / "workspace", FakeEmbedder())


def _passages(service: Any) -> dict[str, dict[str, str]]:
    db = service.indexer.db
    found = db.search("venue question about", limit=25, turns=True)
    return {m["turn_item_id"]: m for m in db.turn_meta([c.id for c, _ in found]).values()}


SIDE_LABELS = {SIDE_CHAT_LABEL_KEY: "1", SIDE_CHAT_PARENT_LABEL_KEY: "conv_main"}


@pytest.mark.asyncio
async def test_retired_turns_become_one_passage_each_with_their_metadata(tmp_path: Path) -> None:
    from omnigent.runner.memory.sync import index_retired_turns

    service = _service(tmp_path)
    window = [*_turns("s", 2), _say("n1", "user", "[System: x]", "rn")]
    record = _Record({})

    await index_retired_turns(
        record, "conv_side", SIDE_LABELS, window, project="spring", runtime=service
    )

    found = _passages(service)
    assert sorted(found) == ["su0", "su1"]  # a notice is never one
    assert found["su1"] == {
        "chat_id": "conv_side", "turn_item_id": "su1", "date": "2026-10-12", "origin": "side",
        "project": "spring", "person_text": "question 1 about the venue",
    }  # fmt: skip
    assert record.reads == []  # the window is in hand: nothing is read
    assert service.indexer.process_next()  # one indexer tick embeds them
    assert service.indexer.db.files(turns=True)[0].embed_status == "embedded"


@pytest.mark.asyncio
async def test_a_turn_in_the_current_epoch_is_indexed_by_the_compaction_that_retires_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from omnigent.runner.memory import sync
    from omnigent.superchat import rollover

    async def summarize(items: list[dict[str, Any]], **_: Any) -> CompactionData:
        return CompactionData(summary=SUMMARY, last_item_id=items[-1]["id"], token_count=1)

    monkeypatch.setattr(rollover, "build_rollover_item", summarize)
    service = _service(tmp_path)
    record = _Record({"conv_main": [_say("mu0", "user", "question 0 about the venue", "mr0")]})

    async def on_stored(_item: CompactionData, window: list[dict[str, Any]]) -> None:
        await sync.index_retired_turns(record, "conv_main", {}, window, runtime=service)

    async def compact() -> None:
        assert await rollover.roll_over_session(
            "conv_main", labels={}, model="m", server_client=record, on_stored=on_stored
        )

    await sync.backfill_turns(record, "conv_main", {}, runtime=service)  # a new Conversation
    record.items["conv_main"] += [_say("ma0", "assistant", "answer 0", "mr0"), *_turns("m", 2)[2:]]
    await sync.backfill_turns(record, "conv_main", {}, runtime=service)
    assert _passages(service) == {}  # still in the window: not a passage yet

    await compact()
    assert sorted(_passages(service)) == ["mu0", "mu1"]

    record.items["conv_main"] += _turns("n", 1)
    assert sorted(_passages(service)) == ["mu0", "mu1"]
    await compact()  # the next window only: the turns before its anchor are not read again
    assert sorted(_passages(service)) == ["mu0", "mu1", "nu0"]


@pytest.mark.asyncio
async def test_an_archived_side_chat_indexes_the_turns_after_its_last_anchor(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from omnigent.runner.memory import sync

    monkeypatch.setattr(sync, "_ARCHIVE_CHECK_SECONDS", 0)
    service = _service(tmp_path)
    related = {
        "conv_main": [
            {"id": "conv_side", "title": "deck", "archived": True, "updated_at": 5},
            {"id": "conv_open", "title": "open", "archived": False, "updated_at": 5},
        ]
    }
    side = [*_turns("s", 3)]
    side.insert(2, _stored("c1", SUMMARY, last_item_id="sa0"))  # su0 left the window there
    record = _Record({"conv_side": side, "conv_open": _turns("o", 2)}, related)

    await sync.index_archived_chats(record, "conv_main", {}, runtime=service)

    found = _passages(service)
    assert sorted(found) == ["su1", "su2"]  # su0 was its compaction's; an open chat waits
    assert found["su2"]["origin"] == "side"
    record.reads.clear()
    await sync.index_archived_chats(record, "conv_main", {}, runtime=service)
    assert record.reads == []  # once per archive
    related["conv_main"][0]["updated_at"] = 9  # unarchived, used, archived again
    await sync.index_archived_chats(record, "conv_main", {}, runtime=service)
    assert {chat for chat, _ in record.reads} == {"conv_side"}


@pytest.mark.asyncio
async def test_a_helper_turn_is_not_indexed_and_a_failing_write_does_not_raise(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from omnigent.context.labels import (
        CONTEXT_MODE_LABEL,
        SUBAGENT_LABEL_KEY,
        SUPERSIDE_CHAT_MODE_VALUE,
    )
    from omnigent.runner.memory.sync import backfill_turns, index_retired_turns

    service = _service(tmp_path)
    record = _Record({"conv_h": _turns("h", 2), "conv_main": _turns("m", 2)})
    helper = {CONTEXT_MODE_LABEL: SUPERSIDE_CHAT_MODE_VALUE, SUBAGENT_LABEL_KEY: "1"}
    await index_retired_turns(record, "conv_h", helper, _turns("h", 2), runtime=service)
    await backfill_turns(record, "conv_h", helper, runtime=service)
    assert _passages(service) == {} and record.reads == []

    def broken(*_args: Any, **_kwargs: Any) -> int:
        raise OSError("disk full")

    monkeypatch.setattr(service.indexer, "index_turns", broken)
    await index_retired_turns(record, "conv_main", {}, _turns("m", 2), runtime=service)
    await backfill_turns(record, "conv_main", {}, runtime=service)
    assert _passages(service) == {}


@pytest.mark.asyncio
async def test_outside_a_computer_nothing_is_indexed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from omnigent.runner.memory.sync import (
        backfill_turns,
        index_archived_chats,
        index_retired_turns,
    )

    monkeypatch.delenv("IS_SANDBOX", raising=False)
    record = _Record({"conv_main": _turns("m", 2)})
    await index_retired_turns(record, "conv_main", {}, _turns("m", 2))
    await backfill_turns(record, "conv_main", {})
    await index_archived_chats(record, "conv_main", {})
    assert record.reads == []


@pytest.mark.asyncio
async def test_backfill_is_bounded_resumes_and_never_duplicates(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from omnigent.runner.memory import sync

    monkeypatch.setattr(sync, "_BACKFILL_PAGE", "10")
    monkeypatch.setattr(sync, "_BACKFILL_PAGES", 2)
    monkeypatch.setattr(sync, "_BACKFILL_TURNS", 6)
    service = _service(tmp_path)
    related = {"conv_main": [{"id": "conv_fork", "title": "f", "anchor_item_id": "mu1"}]}
    main = _turns("m", 12)
    main.insert(23, _stored("c1", SUMMARY, last_item_id="ma10"))  # mu11 ran while it summarized
    fork = [*_turns("f", 3), _stored("c2", SUMMARY, last_item_id="fa1")]
    record = _Record({"conv_main": main, "conv_fork": fork}, related)

    await sync.backfill_turns(record, "conv_main", {}, runtime=service)
    assert sorted(_passages(service)) == sorted(f"mu{n}" for n in range(6))  # six turns a run

    restarted = _service(tmp_path)  # a restart: the progress is in the index file
    for _ in range(4):
        await sync.backfill_turns(record, "conv_main", {}, runtime=restarted)
    found = _passages(restarted)
    # Every retired turn once; each chat's current epoch waits for the compaction that retires it.
    assert sorted(found) == sorted([*(f"mu{n}" for n in range(11)), "fu0", "fu1"])
    assert found["fu0"]["origin"] == "fork"
    db = restarted.indexer.db
    assert sum(len(db.chunks_for(r.file_id)) for r in db.files(turns=True)) == 13
    assert db.meta("turns_backfilled.v3:conv_main") == "done"
    record.reads.clear()
    await sync.backfill_turns(record, "conv_main", {}, runtime=restarted)
    assert record.reads == []  # done: nothing is read again


@pytest.mark.asyncio
async def test_backfill_starts_over_when_its_cursor_item_is_gone(tmp_path: Path) -> None:
    from omnigent.runner.memory import sync

    service = _service(tmp_path)
    service.indexer.db.set_meta("turns_cursor.v3:conv_main", "gone")
    record = _Record({"conv_main": [*_turns("m", 3), _stored("c1", SUMMARY, last_item_id="ma1")]})
    await sync.backfill_turns(record, "conv_main", {}, runtime=service)
    await sync.backfill_turns(record, "conv_main", {}, runtime=service)
    assert sorted(_passages(service)) == ["mu0", "mu1"]


@pytest.mark.asyncio
async def test_backfill_indexes_every_retired_turn_and_none_of_the_current_epoch(
    tmp_path: Path,
) -> None:
    from omnigent.runner.memory import sync

    service = _service(tmp_path)
    related = {"conv_main": [{"id": "conv_side", "title": "s"}]}
    # The main record ends at its anchor: its newest turn is retired, and no compaction is left
    # to write it. The Side chat's newest turn is after its anchor: the current epoch.
    main = [*_turns("m", 2), _stored("c1", SUMMARY, last_item_id="ma1")]
    side = _turns("s", 3)
    side.insert(4, _stored("c2", SUMMARY, last_item_id="sa1"))
    record = _Record({"conv_main": main, "conv_side": side}, related)

    await sync.backfill_turns(record, "conv_main", {}, runtime=service)

    assert sorted(_passages(service)) == ["mu0", "mu1", "su0", "su1"]
    assert service.indexer.db.meta("turns_backfilled.v3:conv_main") == "done"


@pytest.mark.asyncio
async def test_a_deleted_conversation_takes_its_passages_and_its_side_chats_with_it(
    tmp_path: Path,
) -> None:
    from omnigent.runner.memory.sync import index_retired_turns

    service = _service(tmp_path)
    record = _Record(
        {
            "conv_main": [_stored("c1", SUMMARY), *_turns("m", 2)],
            "conv_side": _turns("s", 2),
            "conv_new": [_stored("n1", SUMMARY), *_turns("n", 2)],
        }
    )
    await rebuild(record, "conv_main", workspace=tmp_path)
    for chat, labels, prefix in (("conv_main", {}, "m"), ("conv_side", SIDE_LABELS, "s")):
        await index_retired_turns(record, chat, labels, _turns(prefix, 2), runtime=service)
    await index_retired_turns(record, "conv_new", {}, _turns("n", 2), runtime=service)

    await reconcile(record, "conv_new", {}, workspace=tmp_path, runtime=service)
    assert len(_passages(service)) == 6  # the old Conversation still exists: nothing goes

    record.deleted.add("conv_main")
    await reconcile(record, "conv_new", {}, workspace=tmp_path, runtime=service)

    assert files.owner_of(tmp_path) == "conv_new"
    assert sorted(_passages(service)) == ["nu0", "nu1"]
    assert [r.name for r in service.indexer.db.files(turns=True)] == ["conv_new"]


@pytest.mark.asyncio
async def test_a_reset_keeps_the_passages(tmp_path: Path) -> None:
    from omnigent.runner.memory.sync import index_retired_turns

    service = _service(tmp_path)
    record = _Record({"conv_main": [_stored("c1", SUMMARY), *_turns("m", 2)]})
    await rebuild(record, "conv_main", workspace=tmp_path)
    await index_retired_turns(record, "conv_main", {}, _turns("m", 2), runtime=service)
    record.items["conv_main"].append(_reset())

    await reconcile(record, "conv_main", {}, workspace=tmp_path, runtime=service)

    assert files.last_reset_of(tmp_path) == "c_reset"
    assert sorted(_passages(service)) == ["mu0", "mu1"]


# ── hand edits ───────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_delivered_hand_edit_becomes_one_journal_line_with_its_version(
    _isolated_knowledge_workspace: Path,
) -> None:
    from omnigent.runner.knowledge.refs import line_refs
    from omnigent.superchat.artifacts.writeback import deliver_manual_edits

    edit = {"id": "art_7f2", "name": "budget.xlsx", "version": 3, "origin": "manual",
            "edit_summary": "B4 1200 → 1500", "created_at": DAY, "write_back": False}  # fmt: skip
    refresh = {**edit, "id": "art_9", "name": "brief.md", "origin": "update"}

    class _Edits:
        posted: list[str] = []

        async def get(self, url: str, **_kwargs: Any) -> Any:
            if url.startswith("/v1/artifacts/pending-edits"):
                return _Resp(200, {"edits": [edit, refresh]})
            return _Resp(200, {"title": "t", "labels": {}})

        async def post(self, url: str, **_kwargs: Any) -> Any:
            self.posted.append(url)
            return _Resp(200, {})

    server = _Edits()
    notes = await deliver_manual_edits(server, "conv_main", roots=[])  # type: ignore[arg-type]

    assert len(notes) == 2 and len(server.posted) == 2
    (line,) = _lines(_isolated_knowledge_workspace)  # a live update's refresh is not the person's
    assert line == (
        "- 2026-10-12 · The person edited budget.xlsx by hand (v3): B4 1200 → 1500 · main "
        "<!-- conv_main artifacts:art_7f2@v3 -->"
    )
    assert line_refs(line) == {"artifacts": ["art_7f2@v3"]}
