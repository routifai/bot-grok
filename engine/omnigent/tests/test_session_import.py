"""Tests for importing local coding-harness sessions."""

from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path

import pytest

from omnigent.session_import import local as local_import
from omnigent.session_import.local import (
    list_recent_local_session_ids,
    load_claude_session,
    load_codex_session,
    load_pi_session,
)
from omnigent.session_import.models import LocalSessionImport, SessionImportNotFoundError


def test_long_pi_entry_ids_get_distinct_bounded_response_ids(tmp_path: Path) -> None:
    """Long native entry ids remain distinct after normalization."""
    native_ids = ("x" * 100 + "a", "x" * 100 + "b")
    home = tmp_path / "pi"
    session_id = "pi-session"
    transcript = home / "sessions" / "--repo--" / f"stamp_{session_id}.jsonl"
    records = [
        {"type": "session", "version": 3, "id": session_id},
        {
            "type": "message",
            "id": native_ids[0],
            "parentId": None,
            "message": {"role": "user", "content": "first"},
        },
        {
            "type": "message",
            "id": native_ids[1],
            "parentId": native_ids[0],
            "message": {
                "role": "assistant",
                "content": [{"type": "text", "text": "second"}],
            },
        },
    ]

    transcript.parent.mkdir(parents=True, exist_ok=True)
    transcript.write_text(
        "".join(f"{json.dumps(record)}\n" for record in records), encoding="utf-8"
    )

    response_ids = [item.response_id for item in load_pi_session(session_id, pi_home=home).items]
    assert len(response_ids) == 2
    assert response_ids[0] != response_ids[1]
    assert all(len(response_id) <= 64 for response_id in response_ids)


def test_load_claude_session_normalizes_parent_transcript(tmp_path: Path) -> None:
    """Claude parent messages and tools become ordinary Omnigent items."""
    session_id = "a1b2c3d4-1234-5678-9abc-def012345678"
    transcript = tmp_path / "projects" / "-repo" / f"{session_id}.jsonl"
    transcript.parent.mkdir(parents=True)
    records = [
        {
            "type": "user",
            "uuid": "user-1",
            "cwd": "/repo",
            "message": {"role": "user", "content": "inspect TODO.md"},
        },
        {
            "type": "assistant",
            "uuid": "assistant-1",
            "message": {
                "role": "assistant",
                "content": [
                    {
                        "type": "tool_use",
                        "id": "toolu_read_1",
                        "name": "Read",
                        "input": {"file_path": "TODO.md"},
                    }
                ],
            },
        },
        {
            "type": "user",
            "uuid": "result-1",
            "message": {
                "role": "user",
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": "toolu_read_1",
                        "content": "contents",
                    }
                ],
            },
        },
        {
            "type": "assistant",
            "uuid": "assistant-2",
            "message": {
                "role": "assistant",
                "content": [{"type": "text", "text": "Done."}],
            },
        },
    ]
    transcript.write_text(
        "".join(f"{json.dumps(record)}\n" for record in records),
        encoding="utf-8",
    )
    # A same-id sub-agent transcript must never be selected as the parent.
    subagent = tmp_path / "projects" / "-repo" / "subagents" / f"{session_id}.jsonl"
    subagent.parent.mkdir()
    subagent.write_text("{}\n", encoding="utf-8")

    imported = load_claude_session(session_id, claude_home=tmp_path)

    assert imported.source == "claude"
    assert imported.external_session_id == session_id
    assert imported.workspace == "/repo"
    assert imported.title == "inspect TODO.md"
    assert [item.type for item in imported.items] == [
        "message",
        "function_call",
        "function_call_output",
        "message",
    ]
    assert imported.items[1].data.model_dump()["call_id"] == "toolu_read_1"
    assert imported.items[3].data.model_dump()["agent"] == "claude-native-ui"


def _write_claude_transcript_with_titles(
    tmp_path: Path,
    session_id: str,
    *,
    ai_title: str | None,
    custom_title: str | None,
) -> None:
    """Write a minimal Claude transcript, optionally stamped with title lines."""
    transcript = tmp_path / "projects" / "-repo" / f"{session_id}.jsonl"
    transcript.parent.mkdir(parents=True)
    records: list[dict[str, object]] = [
        {
            "type": "user",
            "uuid": "user-1",
            "cwd": "/repo",
            "message": {"role": "user", "content": "inspect TODO.md"},
        }
    ]
    if ai_title is not None:
        records.append({"type": "ai-title", "aiTitle": ai_title, "sessionId": session_id})
    if custom_title is not None:
        records.append(
            {"type": "custom-title", "customTitle": custom_title, "sessionId": session_id}
        )
    transcript.write_text(
        "".join(f"{json.dumps(record)}\n" for record in records), encoding="utf-8"
    )


def test_load_claude_session_prefers_custom_title_over_ai_title(tmp_path: Path) -> None:
    """A user rename (custom-title) wins over the generated ai-title."""
    session_id = "a1b2c3d4-1234-5678-9abc-def012345678"
    _write_claude_transcript_with_titles(
        tmp_path, session_id, ai_title="Generated summary", custom_title="My renamed thread"
    )

    imported = load_claude_session(session_id, claude_home=tmp_path)

    assert imported.native_title == "My renamed thread"
    assert imported.title == "My renamed thread"


def test_load_claude_session_falls_back_to_ai_title(tmp_path: Path) -> None:
    """With no rename, the generated ai-title is used over the first message."""
    session_id = "a1b2c3d4-1234-5678-9abc-def012345678"
    _write_claude_transcript_with_titles(
        tmp_path, session_id, ai_title="Generated summary", custom_title=None
    )

    imported = load_claude_session(session_id, claude_home=tmp_path)

    assert imported.native_title == "Generated summary"
    assert imported.title == "Generated summary"


def test_load_claude_session_synthesizes_title_without_native(tmp_path: Path) -> None:
    """No title lines → the title is synthesized from the first user message."""
    session_id = "a1b2c3d4-1234-5678-9abc-def012345678"
    _write_claude_transcript_with_titles(tmp_path, session_id, ai_title=None, custom_title=None)

    imported = load_claude_session(session_id, claude_home=tmp_path)

    assert imported.native_title is None
    assert imported.title == "inspect TODO.md"


def test_load_claude_session_rejects_empty_history(tmp_path: Path) -> None:
    """An empty Claude transcript cannot create a claimed import."""
    session_id = "a1b2c3d4-1234-5678-9abc-def012345678"
    transcript = tmp_path / "projects" / "-repo" / f"{session_id}.jsonl"
    transcript.parent.mkdir(parents=True)
    transcript.touch()

    with pytest.raises(SessionImportNotFoundError, match="no importable history"):
        load_claude_session(session_id, claude_home=tmp_path)


def _write_claude_transcript_with_compaction(tmp_path: Path, session_id: str) -> Path:
    """Write a transcript with a compaction summary splitting two turns."""
    transcript = tmp_path / "projects" / "-repo" / f"{session_id}.jsonl"
    transcript.parent.mkdir(parents=True)
    records = [
        {
            "type": "user",
            "uuid": "user-pre",
            "cwd": "/repo",
            "message": {"role": "user", "content": "first question before compaction"},
        },
        {
            "type": "assistant",
            "uuid": "assistant-pre",
            "message": {"role": "assistant", "content": [{"type": "text", "text": "early reply"}]},
        },
        {
            "type": "user",
            "uuid": "compact-1",
            "isCompactSummary": True,
            "message": {"role": "user", "content": "summary of the conversation so far"},
        },
        {
            "type": "user",
            "uuid": "user-post",
            "message": {"role": "user", "content": "follow-up after compaction"},
        },
        {
            "type": "assistant",
            "uuid": "assistant-post",
            "message": {"role": "assistant", "content": [{"type": "text", "text": "later reply"}]},
        },
    ]
    transcript.write_text(
        "".join(f"{json.dumps(record)}\n" for record in records), encoding="utf-8"
    )
    return transcript


def test_load_claude_session_keeps_full_history_below_size_threshold(tmp_path: Path) -> None:
    """A small transcript imports whole, even when it contains a compaction summary."""
    session_id = "a1b2c3d4-1234-5678-9abc-def012345678"
    _write_claude_transcript_with_compaction(tmp_path, session_id)

    imported = load_claude_session(session_id, claude_home=tmp_path)

    # Pre-compaction turn, the summary, and the post-compaction turn all present.
    texts = [
        block["text"]
        for item in imported.items
        for block in item.data.model_dump().get("content", [])
        if isinstance(block, dict) and "text" in block
    ]
    assert "first question before compaction" in texts
    assert "summary of the conversation so far" in texts
    assert "follow-up after compaction" in texts


def test_load_claude_session_trims_to_last_compaction_when_large(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A transcript past the size threshold imports only from the last compaction summary."""
    session_id = "a1b2c3d4-1234-5678-9abc-def012345678"
    _write_claude_transcript_with_compaction(tmp_path, session_id)
    # Force the large-file path without writing multiple megabytes.
    monkeypatch.setattr(local_import, "_IMPORT_COMPACT_TRIM_BYTES", 0)

    imported = load_claude_session(session_id, claude_home=tmp_path)

    texts = [
        block["text"]
        for item in imported.items
        for block in item.data.model_dump().get("content", [])
        if isinstance(block, dict) and "text" in block
    ]
    # Pre-compaction records the live agent no longer sees are dropped; the
    # summary and everything after it are kept.
    assert "first question before compaction" not in texts
    assert "early reply" not in texts
    assert "summary of the conversation so far" in texts
    assert "follow-up after compaction" in texts
    assert "later reply" in texts


def test_load_claude_session_large_without_compaction_imports_all(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A large transcript that never compacted keeps its full history."""
    session_id = "a1b2c3d4-1234-5678-9abc-def012345678"
    _write_claude_transcript_with_titles(tmp_path, session_id, ai_title=None, custom_title=None)
    monkeypatch.setattr(local_import, "_IMPORT_COMPACT_TRIM_BYTES", 0)

    imported = load_claude_session(session_id, claude_home=tmp_path)

    # No isCompactSummary boundary → trimming is a no-op, first message stays.
    assert imported.title == "inspect TODO.md"
    assert imported.items


def test_load_claude_session_trims_to_final_compaction_with_multiple(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With several compactions, only the last boundary onward is imported."""
    session_id = "a1b2c3d4-1234-5678-9abc-def012345678"
    transcript = tmp_path / "projects" / "-repo" / f"{session_id}.jsonl"
    transcript.parent.mkdir(parents=True)
    records = [
        {
            "type": "user",
            "uuid": "user-0",
            "cwd": "/repo",
            "message": {"role": "user", "content": "original"},
        },
        {
            "type": "user",
            "uuid": "compact-1",
            "isCompactSummary": True,
            "message": {"role": "user", "content": "first summary"},
        },
        {
            "type": "user",
            "uuid": "compact-2",
            "isCompactSummary": True,
            "message": {"role": "user", "content": "second summary"},
        },
        {
            "type": "user",
            "uuid": "user-final",
            "message": {"role": "user", "content": "after second"},
        },
    ]
    transcript.write_text(
        "".join(f"{json.dumps(record)}\n" for record in records), encoding="utf-8"
    )
    monkeypatch.setattr(local_import, "_IMPORT_COMPACT_TRIM_BYTES", 0)

    imported = load_claude_session(session_id, claude_home=tmp_path)

    texts = [
        block["text"]
        for item in imported.items
        for block in item.data.model_dump().get("content", [])
        if isinstance(block, dict) and "text" in block
    ]
    assert "original" not in texts
    assert "first summary" not in texts
    assert "second summary" in texts
    assert "after second" in texts


def test_load_claude_session_trims_at_real_two_mb_threshold(tmp_path: Path) -> None:
    """Past the real 2 MB threshold, pre-compaction records are dropped (no patch)."""
    session_id = "a1b2c3d4-1234-5678-9abc-def012345678"
    transcript = tmp_path / "projects" / "-repo" / f"{session_id}.jsonl"
    transcript.parent.mkdir(parents=True)
    filler = "x" * 4096  # ~4 KB per record; ~600 records clears 2 MB.
    records: list[dict[str, object]] = [
        {
            "type": "user",
            "uuid": f"pre-{i}",
            "cwd": "/repo",
            "message": {"role": "user", "content": f"pre-compaction {i} {filler}"},
        }
        for i in range(600)
    ]
    records.append(
        {
            "type": "user",
            "uuid": "compact-1",
            "isCompactSummary": True,
            "message": {"role": "user", "content": "post compaction summary marker"},
        }
    )
    records.append(
        {
            "type": "user",
            "uuid": "post-1",
            "message": {"role": "user", "content": "question after compaction marker"},
        }
    )
    transcript.write_text(
        "".join(f"{json.dumps(record)}\n" for record in records), encoding="utf-8"
    )
    assert transcript.stat().st_size > 2 * 1024 * 1024

    imported = load_claude_session(session_id, claude_home=tmp_path)

    texts = [
        block["text"]
        for item in imported.items
        for block in item.data.model_dump().get("content", [])
        if isinstance(block, dict) and "text" in block
    ]
    assert not any(text.startswith("pre-compaction") for text in texts)
    assert any("post compaction summary marker" in text for text in texts)
    assert any("question after compaction marker" in text for text in texts)


def test_load_claude_session_titles_from_user_message_not_compaction_summary(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A trimmed-to-compaction import titles from a real user turn, not the summary.

    The continuation summary leads the trimmed items, so without flagging it meta
    the title would be "summary of the conversation so far", an instruction-like
    title. It is durable context (is_meta), so the title falls through to the
    first real user message.
    """
    session_id = "a1b2c3d4-1234-5678-9abc-def012345678"
    _write_claude_transcript_with_compaction(tmp_path, session_id)
    monkeypatch.setattr(local_import, "_IMPORT_COMPACT_TRIM_BYTES", 0)

    imported = load_claude_session(session_id, claude_home=tmp_path)

    assert imported.title == "follow-up after compaction"
    # The summary still imports (durable context) but is flagged meta so it is
    # hidden from the user-facing transcript and skipped for the title.
    summary = imported.items[0].data.model_dump()
    assert summary["content"][0]["text"] == "summary of the conversation so far"
    assert summary["is_meta"] is True


def test_list_recent_codex_sessions_excludes_non_interactive_sources(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Recent-import lists only interactive Codex sessions, like Codex's own picker.

    ``exec`` runs and sub-agent threads are automation the user never opened
    interactively (their first message is an injected instruction), so they are
    excluded; a rollout predating the ``source`` field defaults to interactive.
    """
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    sessions = tmp_path / "sessions" / "2026" / "07" / "16"
    sessions.mkdir(parents=True)
    cases = {
        "019f7777-0001-7000-8000-00000000000c": ("cli", 4),
        "019f7777-0001-7000-8000-00000000000e": ("exec", 3),
        "019f7777-0001-7000-8000-00000000000a": ({"subagent": {"review": {}}}, 2),
        "019f7777-0001-7000-8000-00000000000f": (None, 1),  # no source field
    }
    for session_id, (source, modified_at) in cases.items():
        rollout = sessions / f"rollout-2026-07-16T00-00-0{modified_at}-{session_id}.jsonl"
        payload: dict[str, object] = {"id": session_id, "cwd": "/repo"}
        if source is not None:
            payload["source"] = source
        rollout.write_text(
            json.dumps({"type": "session_meta", "payload": payload}) + "\n",
            encoding="utf-8",
        )
        os.utime(rollout, (modified_at, modified_at))

    recent = list_recent_local_session_ids("codex", limit=10)

    # cli (newest) and the source-less legacy rollout only; exec + subagent dropped.
    assert recent == (
        "019f7777-0001-7000-8000-00000000000c",
        "019f7777-0001-7000-8000-00000000000f",
    )


def test_list_recent_claude_sessions_orders_parents_and_applies_limit(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Claude batch discovery returns only the newest parent transcripts."""
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path))
    project = tmp_path / "projects" / "-repo"
    project.mkdir(parents=True)
    transcripts = [
        (project / "old.jsonl", 1),
        (project / "middle.jsonl", 2),
        (project / "new.jsonl", 3),
    ]
    for path, modified_at in transcripts:
        path.touch()
        os.utime(path, (modified_at, modified_at))
    subagent = project / "subagents" / "subagent.jsonl"
    subagent.parent.mkdir()
    subagent.touch()
    os.utime(subagent, (4, 4))

    recent = list_recent_local_session_ids("claude", limit=2)

    assert recent == ("new", "middle")


def test_load_codex_session_normalizes_response_items(tmp_path: Path) -> None:
    """Codex response items retain turn grouping and omit scaffolding."""
    session_id = "019e96aa-0be2-7343-8d3b-6f914d60936b"
    rollout = (
        tmp_path
        / "sessions"
        / "2026"
        / "07"
        / "15"
        / f"rollout-2026-07-15T12-00-00-{session_id}.jsonl"
    )
    rollout.parent.mkdir(parents=True)
    records = [
        {
            "type": "session_meta",
            "payload": {"id": session_id, "cwd": "/repo"},
        },
        {
            "type": "turn_context",
            "payload": {"turn_id": "turn_1", "cwd": "/repo"},
        },
        {
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "developer",
                "content": [{"type": "input_text", "text": "internal"}],
            },
        },
        {
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": "<environment_context>\n<cwd>/repo</cwd>\n</environment_context>",
                    }
                ],
            },
        },
        {
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [
                    {"type": "input_text", "text": "inspect TODO.md"},
                    {"type": "input_image", "image_url": "data:image/png;base64,abc"},
                ],
            },
        },
        {
            "type": "response_item",
            "payload": {
                "type": "function_call",
                "name": "shell",
                "arguments": '{"command":"cat TODO.md"}',
                "call_id": "call_1",
            },
        },
        {
            "type": "response_item",
            "payload": {
                "type": "function_call_output",
                "call_id": "call_1",
                "output": [
                    {"type": "input_text", "text": "first line\n"},
                    {"type": "input_text", "text": "second line"},
                ],
            },
        },
        {
            "type": "response_item",
            "payload": {
                "type": "custom_tool_call",
                "name": "apply_patch",
                "input": "*** Begin Patch",
                "call_id": "call_2",
            },
        },
        {
            "type": "response_item",
            "payload": {
                "type": "custom_tool_call_output",
                "call_id": "call_2",
                "output": [{"type": "output_text", "text": ""}],
            },
        },
        {
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": "Done."}],
            },
        },
    ]
    rollout.write_text(
        "".join(f"{json.dumps(record)}\n" for record in records),
        encoding="utf-8",
    )

    imported = load_codex_session(session_id, codex_home=tmp_path)

    assert imported.source == "codex"
    assert imported.workspace == "/repo"
    assert imported.title == "inspect TODO.md"
    assert [item.type for item in imported.items] == [
        "message",
        "message",
        "function_call",
        "function_call_output",
        "function_call",
        "function_call_output",
        "message",
    ]
    assert {item.response_id for item in imported.items} == {"codex:turn_1"}
    assert imported.items[0].data.model_dump()["is_meta"] is True
    assert imported.items[1].data.model_dump()["content"][1] == {
        "type": "input_image",
        "image_url": "data:image/png;base64,abc",
    }
    assert imported.items[2].data.model_dump() == {
        "agent": "codex-native-ui",
        "name": "shell",
        "arguments": '{"command":"cat TODO.md"}',
        "call_id": "call_1",
    }
    assert imported.items[3].data.model_dump() == {
        "call_id": "call_1",
        "output": "first line\nsecond line",
    }
    assert imported.items[5].data.model_dump() == {
        "call_id": "call_2",
        "output": "",
    }


def _codex_item_texts(imported: LocalSessionImport) -> list[str]:
    """Flatten the text of every message item in an imported Codex session."""
    return [
        block["text"]
        for item in imported.items
        for block in item.data.model_dump().get("content", [])
        if isinstance(block, dict) and isinstance(block.get("text"), str)
    ]


def _write_codex_rollout_with_compaction(
    tmp_path: Path, session_id: str, *, extra_pre: list[dict] | None = None
) -> Path:
    """Write a Codex rollout with a ``compacted`` record between two turns."""
    rollout = (
        tmp_path
        / "sessions"
        / "2026"
        / "07"
        / "15"
        / f"rollout-2026-07-15T12-00-00-{session_id}.jsonl"
    )
    rollout.parent.mkdir(parents=True)
    records: list[dict] = [
        {"type": "session_meta", "payload": {"id": session_id, "cwd": "/repo"}},
        {"type": "turn_context", "payload": {"turn_id": "turn_1", "cwd": "/repo"}},
        {
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "pre compaction question"}],
            },
        },
        {
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": "pre compaction answer"}],
            },
        },
    ]
    records.extend(extra_pre or [])
    records.append(
        {
            "type": "compacted",
            "payload": {
                "replacement_history": [
                    {
                        "type": "message",
                        "role": "user",
                        "content": [{"type": "input_text", "text": "compaction summary baseline"}],
                    }
                ],
                "window_id": 1,
            },
        }
    )
    records.extend(
        [
            {"type": "turn_context", "payload": {"turn_id": "turn_2", "cwd": "/repo"}},
            {
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": "post compaction question"}],
                },
            },
            {
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "post compaction answer"}],
                },
            },
        ]
    )
    rollout.write_text("".join(f"{json.dumps(record)}\n" for record in records), encoding="utf-8")
    return rollout


def test_load_codex_session_keeps_full_history_below_size_threshold(tmp_path: Path) -> None:
    """A small rollout imports the raw history whole; the compacted record is ignored."""
    session_id = "019e96aa-0be2-7343-8d3b-6f914d60936b"
    _write_codex_rollout_with_compaction(tmp_path, session_id)

    imported = load_codex_session(session_id, codex_home=tmp_path)

    texts = _codex_item_texts(imported)
    assert "pre compaction question" in texts
    assert "post compaction question" in texts
    # The compacted record's replacement_history is not surfaced below threshold.
    assert "compaction summary baseline" not in texts


def test_load_codex_session_trims_to_last_compaction_when_large(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Past the threshold, only the compaction baseline and later turns import."""
    session_id = "019e96aa-0be2-7343-8d3b-6f914d60936b"
    _write_codex_rollout_with_compaction(tmp_path, session_id)
    monkeypatch.setattr(local_import, "_IMPORT_COMPACT_TRIM_BYTES", 0)

    imported = load_codex_session(session_id, codex_home=tmp_path)

    texts = _codex_item_texts(imported)
    # Pre-compaction records the live agent no longer sees are dropped.
    assert "pre compaction question" not in texts
    assert "pre compaction answer" not in texts
    # The replacement_history baseline and post-compaction turns are kept.
    assert "compaction summary baseline" in texts
    assert "post compaction question" in texts
    assert "post compaction answer" in texts


def test_load_codex_session_trims_to_final_compaction_with_multiple(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With two compactions, only the last baseline onward survives."""
    session_id = "019e96aa-0be2-7343-8d3b-6f914d60936b"
    # A second compaction after the first: its replacement_history is the final
    # baseline, so the first summary must not survive.
    extra_pre = [
        {
            "type": "compacted",
            "payload": {
                "replacement_history": [
                    {
                        "type": "message",
                        "role": "user",
                        "content": [{"type": "input_text", "text": "first summary baseline"}],
                    }
                ]
            },
        },
        {
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "between compactions"}],
            },
        },
    ]
    _write_codex_rollout_with_compaction(tmp_path, session_id, extra_pre=extra_pre)
    monkeypatch.setattr(local_import, "_IMPORT_COMPACT_TRIM_BYTES", 0)

    imported = load_codex_session(session_id, codex_home=tmp_path)

    texts = _codex_item_texts(imported)
    assert "first summary baseline" not in texts
    assert "between compactions" not in texts
    assert "compaction summary baseline" in texts
    assert "post compaction question" in texts


def test_load_codex_session_ignores_empty_compaction_boundary_when_large(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A compacted record with no usable replacement_history does not wipe history."""
    session_id = "019e96aa-0be2-7343-8d3b-6f914d60936b"
    rollout = (
        tmp_path
        / "sessions"
        / "2026"
        / "07"
        / "15"
        / f"rollout-2026-07-15T12-00-00-{session_id}.jsonl"
    )
    rollout.parent.mkdir(parents=True)
    records = [
        {"type": "session_meta", "payload": {"id": session_id, "cwd": "/repo"}},
        {"type": "turn_context", "payload": {"turn_id": "turn_1", "cwd": "/repo"}},
        {
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "only real turn"}],
            },
        },
        # Degenerate boundary: empty replacement_history. Must not drop everything.
        {"type": "compacted", "payload": {"replacement_history": []}},
    ]
    rollout.write_text("".join(f"{json.dumps(record)}\n" for record in records), encoding="utf-8")
    monkeypatch.setattr(local_import, "_IMPORT_COMPACT_TRIM_BYTES", 0)

    imported = load_codex_session(session_id, codex_home=tmp_path)

    assert _codex_item_texts(imported) == ["only real turn"]


def test_load_codex_session_trims_at_real_two_mb_threshold(tmp_path: Path) -> None:
    """Past the real 2 MB threshold, pre-compaction Codex records are dropped (no patch)."""
    session_id = "019e96aa-0be2-7343-8d3b-6f914d60936b"
    filler = "x" * 4096
    extra_pre = [
        {
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": f"pre bulk {i} {filler}"}],
            },
        }
        for i in range(600)
    ]
    rollout = _write_codex_rollout_with_compaction(tmp_path, session_id, extra_pre=extra_pre)
    assert rollout.stat().st_size > 2 * 1024 * 1024

    imported = load_codex_session(session_id, codex_home=tmp_path)

    texts = _codex_item_texts(imported)
    assert not any(text.startswith("pre bulk") for text in texts)
    assert "pre compaction question" not in texts
    assert "compaction summary baseline" in texts
    assert "post compaction question" in texts


def _write_codex_rollout(tmp_path: Path, session_id: str, *, first_message: str) -> None:
    """Write a minimal importable Codex rollout with one user message."""
    rollout = (
        tmp_path
        / "sessions"
        / "2026"
        / "07"
        / "15"
        / f"rollout-2026-07-15T12-00-00-{session_id}.jsonl"
    )
    rollout.parent.mkdir(parents=True)
    records = [
        {"type": "session_meta", "payload": {"id": session_id, "cwd": "/repo"}},
        {"type": "turn_context", "payload": {"turn_id": "turn_1", "cwd": "/repo"}},
        {
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": first_message}],
            },
        },
    ]
    rollout.write_text("".join(f"{json.dumps(record)}\n" for record in records), encoding="utf-8")


def _write_codex_threads_db(
    tmp_path: Path, session_id: str, *, title: str, first_user_message: str
) -> None:
    """Write a codex ``state_5.sqlite`` holding one thread's title metadata."""
    con = sqlite3.connect(tmp_path / "state_5.sqlite")
    try:
        con.execute("CREATE TABLE threads (id TEXT, title TEXT, first_user_message TEXT)")
        con.execute(
            "INSERT INTO threads (id, title, first_user_message) VALUES (?, ?, ?)",
            (session_id, title, first_user_message),
        )
        con.commit()
    finally:
        con.close()


def test_load_codex_session_uses_custom_thread_title(tmp_path: Path) -> None:
    """A renamed Codex thread (title != first message) carries its custom name."""
    session_id = "019e96aa-0be2-7343-8d3b-6f914d60936b"
    _write_codex_rollout(tmp_path, session_id, first_message="inspect TODO.md")
    _write_codex_threads_db(
        tmp_path, session_id, title="my renamed thread", first_user_message="inspect TODO.md"
    )

    imported = load_codex_session(session_id, codex_home=tmp_path)

    assert imported.native_title == "my renamed thread"
    assert imported.title == "my renamed thread"


def test_load_codex_session_ignores_auto_thread_title(tmp_path: Path) -> None:
    """An un-renamed thread (title == first message) synthesizes from items instead."""
    session_id = "019e96aa-0be2-7343-8d3b-6f914d60936b"
    _write_codex_rollout(tmp_path, session_id, first_message="inspect TODO.md")
    _write_codex_threads_db(
        tmp_path, session_id, title="inspect TODO.md", first_user_message="inspect TODO.md"
    )

    imported = load_codex_session(session_id, codex_home=tmp_path)

    assert imported.native_title is None
    assert imported.title == "inspect TODO.md"


def test_load_codex_session_uses_session_index_rename(tmp_path: Path) -> None:
    """A rename lives in session_index.jsonl even when threads.title still lags.

    Renaming a Codex thread records ``thread_name`` in ``session_index.jsonl``
    while ``threads.title`` can keep the original first message — so the index
    must win.
    """
    session_id = "019e96aa-0be2-7343-8d3b-6f914d60936b"
    _write_codex_rollout(tmp_path, session_id, first_message="inspect TODO.md")
    _write_codex_threads_db(
        tmp_path, session_id, title="inspect TODO.md", first_user_message="inspect TODO.md"
    )
    # An earlier auto entry, then the user's rename — last entry for the id wins.
    (tmp_path / "session_index.jsonl").write_text(
        json.dumps({"id": session_id, "thread_name": "inspect TODO.md"})
        + "\n"
        + json.dumps({"id": session_id, "thread_name": "my-renamed-thread"})
        + "\n",
        encoding="utf-8",
    )

    imported = load_codex_session(session_id, codex_home=tmp_path)

    assert imported.native_title == "my-renamed-thread"
    assert imported.title == "my-renamed-thread"


def test_load_codex_session_finds_archived_rollout(tmp_path: Path) -> None:
    """Archived Codex sessions remain importable by their original id."""
    session_id = "019e96aa-0be2-7343-8d3b-6f914d60936b"
    rollout = tmp_path / "archived_sessions" / f"rollout-2026-07-15-{session_id}.jsonl"
    rollout.parent.mkdir()
    rollout.write_text(
        "".join(
            [
                json.dumps(
                    {"type": "session_meta", "payload": {"id": session_id, "cwd": "/repo"}}
                ),
                "\n",
                json.dumps(
                    {
                        "type": "response_item",
                        "payload": {
                            "type": "message",
                            "role": "user",
                            "content": [{"type": "input_text", "text": "archived prompt"}],
                        },
                    }
                ),
                "\n",
            ]
        ),
        encoding="utf-8",
    )

    imported = load_codex_session(session_id, codex_home=tmp_path)

    assert imported.workspace == "/repo"
    assert imported.title == "archived prompt"


def test_load_codex_session_rejects_empty_history(tmp_path: Path) -> None:
    """A structurally present but unreadable history must not claim an import."""
    session_id = "019e96aa-0be2-7343-8d3b-6f914d60936b"
    rollout = tmp_path / "sessions" / "2026" / "07" / "15" / f"rollout-x-{session_id}.jsonl"
    rollout.parent.mkdir(parents=True)
    rollout.write_text("not-json\n", encoding="utf-8")

    with pytest.raises(SessionImportNotFoundError, match="no importable history"):
        load_codex_session(session_id, codex_home=tmp_path)


def test_list_recent_codex_sessions_includes_archived_and_deduplicates(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Codex batch discovery combines active and archived rollout identities."""
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    first_id = "019e96aa-0be2-7343-8d3b-6f914d60936b"
    second_id = "019f680e-3edc-7fa3-9d50-1c4be395fa27"
    active_dir = tmp_path / "sessions" / "2026" / "07" / "16"
    archived_dir = tmp_path / "archived_sessions"
    active_dir.mkdir(parents=True)
    archived_dir.mkdir()
    rollouts = [
        (active_dir / f"rollout-old-{first_id}.jsonl", 1),
        (active_dir / f"rollout-new-{second_id}.jsonl", 3),
        (archived_dir / f"rollout-archived-{first_id}.jsonl", 4),
        (active_dir / "rollout-malformed.jsonl", 5),
    ]
    for path, modified_at in rollouts:
        path.touch()
        os.utime(path, (modified_at, modified_at))

    recent = list_recent_local_session_ids("codex", limit=10)

    assert recent == (first_id, second_id)


def test_load_pi_session_follows_the_current_branch(tmp_path: Path) -> None:
    """Pi import follows parent links from the last entry instead of stale branches."""
    session_id = "019f8648-2797-7170-bf73-837f2655c47e"
    transcript = tmp_path / "sessions" / "--repo--" / f"stamp_{session_id}.jsonl"
    transcript.parent.mkdir(parents=True)
    records = [
        {"type": "session", "version": 3, "id": session_id, "cwd": "/repo"},
        {
            "type": "message",
            "id": "root-user",
            "parentId": None,
            "message": {"role": "user", "content": [{"type": "text", "text": "start"}]},
        },
        {
            "type": "message",
            "id": "stale-assistant",
            "parentId": "root-user",
            "message": {
                "role": "assistant",
                "content": [{"type": "text", "text": "stale branch"}],
            },
        },
        {
            "type": "message",
            "id": "active-user",
            "parentId": "root-user",
            "message": {"role": "user", "content": "take another approach"},
        },
        {
            "type": "message",
            "id": "active-assistant",
            "parentId": "active-user",
            "message": {
                "role": "assistant",
                "content": [{"type": "text", "text": "active answer"}],
            },
        },
    ]
    transcript.write_text(
        "".join(f"{json.dumps(record)}\n" for record in records), encoding="utf-8"
    )

    imported = load_pi_session(session_id, pi_home=tmp_path)

    assert imported.source == "pi"
    assert imported.workspace == "/repo"
    assert [item.data.model_dump()["content"][0]["text"] for item in imported.items] == [
        "start",
        "take another approach",
        "active answer",
    ]


def test_load_pi_session_preserves_tool_calls_and_results(tmp_path: Path) -> None:
    """Pi assistant tool blocks and tool results remain ordinary tool items."""
    session_id = "019f8648-2797-7170-bf73-837f2655c47e"
    transcript = tmp_path / "sessions" / "--repo--" / f"stamp_{session_id}.jsonl"
    transcript.parent.mkdir(parents=True)
    records = [
        {"type": "session", "version": 3, "id": session_id, "cwd": "/repo"},
        {
            "type": "message",
            "id": "assistant-tool",
            "parentId": None,
            "message": {
                "role": "assistant",
                "content": [
                    {"type": "text", "text": "Checking."},
                    {
                        "type": "toolCall",
                        "id": "call-1",
                        "name": "bash",
                        "arguments": {"cmd": "ls"},
                    },
                ],
            },
        },
        {
            "type": "message",
            "id": "tool-result",
            "parentId": "assistant-tool",
            "message": {
                "role": "toolResult",
                "toolCallId": "call-1",
                "content": [{"type": "text", "text": "README.md"}],
            },
        },
    ]
    transcript.write_text(
        "".join(f"{json.dumps(record)}\n" for record in records), encoding="utf-8"
    )

    imported = load_pi_session(session_id, pi_home=tmp_path)

    assert [item.type for item in imported.items] == [
        "message",
        "function_call",
        "function_call_output",
    ]
    assert imported.items[1].data.model_dump() == {
        "agent": "pi-native-ui",
        "name": "bash",
        "arguments": '{"cmd":"ls"}',
        "call_id": "call-1",
    }
    assert imported.items[2].data.model_dump() == {
        "call_id": "call-1",
        "output": "README.md",
    }


def test_load_pi_session_rejects_an_orphaned_active_leaf(tmp_path: Path) -> None:
    """A broken Pi parent chain cannot be claimed as a partial import."""
    session_id = "019f8648-2797-7170-bf73-837f2655c47e"
    transcript = tmp_path / "sessions" / "--repo--" / f"stamp_{session_id}.jsonl"
    transcript.parent.mkdir(parents=True)
    records = [
        {"type": "session", "version": 3, "id": session_id, "cwd": "/repo"},
        {
            "type": "message",
            "id": "orphan",
            "parentId": "missing",
            "message": {"role": "user", "content": "partial"},
        },
    ]
    transcript.write_text(
        "".join(f"{json.dumps(record)}\n" for record in records), encoding="utf-8"
    )

    with pytest.raises(SessionImportNotFoundError, match="no importable history"):
        load_pi_session(session_id, pi_home=tmp_path)


def test_load_pi_session_migrates_legacy_linear_history(tmp_path: Path) -> None:
    """Pi v1 entries without tree ids import in their original linear order."""
    session_id = "legacy.session"
    transcript = tmp_path / "sessions" / "--repo--" / f"stamp_{session_id}.jsonl"
    transcript.parent.mkdir(parents=True)
    records = [
        {"type": "session", "version": 1, "id": session_id, "cwd": "/repo"},
        {"type": "message", "message": {"role": "user", "content": "hello"}},
        {
            "type": "message",
            "message": {
                "role": "assistant",
                "content": [{"type": "text", "text": "hi"}],
            },
        },
    ]
    transcript.write_text(
        "".join(f"{json.dumps(record)}\n" for record in records), encoding="utf-8"
    )

    imported = load_pi_session(session_id, pi_home=tmp_path)

    assert [item.data.model_dump()["content"][0]["text"] for item in imported.items] == [
        "hello",
        "hi",
    ]


def test_load_pi_session_preserves_images_tool_order_and_aborted_state(tmp_path: Path) -> None:
    """Pi content retains images, tool position, and interrupted assistant state."""
    session_id = "my-feature"
    transcript = tmp_path / "sessions" / "--repo--" / f"stamp_{session_id}.jsonl"
    transcript.parent.mkdir(parents=True)
    records = [
        {"type": "session", "version": 3, "id": session_id, "cwd": "/repo"},
        {
            "type": "message",
            "id": "11111111",
            "parentId": None,
            "message": {
                "role": "user",
                "content": [
                    {"type": "image", "data": "AAAA", "mimeType": "image/png"},
                    {"type": "text", "text": "inspect this"},
                ],
            },
        },
        {
            "type": "message",
            "id": "22222222",
            "parentId": "11111111",
            "message": {
                "role": "assistant",
                "stopReason": "aborted",
                "content": [
                    {"type": "text", "text": "Before."},
                    {
                        "type": "toolCall",
                        "id": "call-1",
                        "name": "bash",
                        "arguments": {"cmd": "ls"},
                    },
                    {"type": "text", "text": "After."},
                ],
            },
        },
    ]
    transcript.write_text(
        "".join(f"{json.dumps(record)}\n" for record in records), encoding="utf-8"
    )

    imported = load_pi_session(session_id, pi_home=tmp_path)

    assert [item.type for item in imported.items] == [
        "message",
        "message",
        "function_call",
        "message",
    ]
    assert imported.items[0].data.model_dump()["content"] == [
        {"type": "input_image", "image_url": "data:image/png;base64,AAAA"},
        {"type": "input_text", "text": "inspect this"},
    ]
    assert imported.items[1].data.model_dump()["interrupted"] is True
    assert imported.items[3].data.model_dump()["interrupted"] is True


def test_load_pi_session_preserves_active_branch_summary(tmp_path: Path) -> None:
    """Pi branch summaries remain durable context for later active turns."""
    session_id = "branch-summary"
    transcript = tmp_path / "sessions" / "--repo--" / f"stamp_{session_id}.jsonl"
    transcript.parent.mkdir(parents=True)
    records = [
        {"type": "session", "version": 3, "id": session_id, "cwd": "/repo"},
        {
            "type": "message",
            "id": "11111111",
            "parentId": None,
            "message": {"role": "user", "content": "start"},
        },
        {
            "type": "branch_summary",
            "id": "22222222",
            "parentId": "11111111",
            "fromId": "stale-leaf",
            "summary": "Changed auth.py and found a token race.",
        },
        {
            "type": "message",
            "id": "33333333",
            "parentId": "22222222",
            "message": {"role": "user", "content": "continue"},
        },
    ]
    transcript.write_text(
        "".join(f"{json.dumps(record)}\n" for record in records), encoding="utf-8"
    )

    imported = load_pi_session(session_id, pi_home=tmp_path)

    assert [item.data.is_meta for item in imported.items] == [False, True, False]
    assert "Changed auth.py" in imported.items[1].data.model_dump()["content"][0]["text"]


def test_list_recent_pi_sessions_scans_project_directories(tmp_path: Path, monkeypatch) -> None:
    """Pi batch discovery extracts session UUIDs from timestamped files."""
    monkeypatch.setenv("PI_CODING_AGENT_DIR", str(tmp_path))
    session_ids = (
        "019f8648-2797-7170-bf73-837f2655c471",
        "019f8648-2797-7170-bf73-837f2655c472",
    )
    for index, session_id in enumerate(session_ids, start=1):
        transcript = tmp_path / "sessions" / f"--repo-{index}--" / f"stamp_{session_id}.jsonl"
        transcript.parent.mkdir(parents=True)
        transcript.write_text(
            json.dumps({"type": "session", "version": 3, "id": session_id}) + "\n",
            encoding="utf-8",
        )
        os.utime(transcript, (index, index))

    recent = list_recent_local_session_ids("pi", limit=10)

    assert recent == tuple(reversed(session_ids))


def test_list_recent_pi_sessions_supports_custom_ids(tmp_path: Path, monkeypatch) -> None:
    """Pi discovery reads safe custom session ids from transcript headers."""
    monkeypatch.setenv("PI_CODING_AGENT_DIR", str(tmp_path))
    transcript = tmp_path / "sessions" / "--repo--" / "stamp_my-feature.jsonl"
    transcript.parent.mkdir(parents=True)
    transcript.write_text(
        json.dumps({"type": "session", "version": 3, "id": "my-feature", "cwd": "/repo"}) + "\n",
        encoding="utf-8",
    )

    assert list_recent_local_session_ids("pi", limit=10) == ("my-feature",)


def test_list_recent_sessions_across_harnesses_merges_by_global_recency(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """'all' keeps the globally-newest sessions, not `limit` per harness."""
    per_source = {
        "claude": [("c_new", 100.0), ("c_old", 10.0)],
        "codex": [("x_mid", 50.0), ("x_older", 5.0)],
    }

    def fake_recency(source: str, *, limit: int) -> list[tuple[str, float]]:
        return per_source.get(source, [])[:limit]

    monkeypatch.setattr(local_import, "_recent_local_sessions_with_recency", fake_recency)

    result = local_import.list_recent_sessions_across_harnesses(limit=3)

    # Top 3 by global recency, newest first — not 3 from each harness.
    assert result == [("claude", "c_new"), ("codex", "x_mid"), ("claude", "c_old")]
