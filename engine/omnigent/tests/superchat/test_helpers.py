"""start_helper: schema, who is offered it, title, dedup, translation, files in the result."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
import yaml

from omnigent.context.labels import (
    CONTEXT_MODE_LABEL,
    SUBAGENT_LABEL_KEY,
    SUPERSIDE_CHAT_MODE_VALUE,
)
from omnigent.superchat.cards.tools import build_card
from omnigent.superchat.feature import (
    HandlerCtx,
    SpawnRequest,
    SpawnResult,
    SubAgentHost,
    ToolManagerCtx,
)
from omnigent.superchat.features import notify_result
from omnigent.superchat.helpers import handlers as h
from omnigent.superchat.helpers import saved_files as sf
from omnigent.superchat.helpers.feature import HELPERS_FEATURE
from omnigent.superchat.helpers.tools import StartHelperTool
from omnigent.superchat.subagents import (
    HELPER_EFFORT_CHOICES,
    HELPER_MODEL_CHOICES,
    format_subagent_wake_notice_with_result,
)

CHAT = {CONTEXT_MODE_LABEL: SUPERSIDE_CHAT_MODE_VALUE}
REPO = Path(__file__).resolve().parents[4]


def _spec(*names: str) -> Any:
    return SimpleNamespace(sub_agents=[SimpleNamespace(name=n) for n in names])


def _offered(labels: dict[str, str] | None, spec: Any) -> list[str]:
    return [t.name() for t in HELPERS_FEATURE.tools(labels, ToolManagerCtx(spec=spec))]


# ── schema and surface ─────────────────────────────────────────────────────


def test_schema_is_one_flat_task_with_fast_strong() -> None:
    params = StartHelperTool().get_schema()["function"]["parameters"]
    assert params["required"] == ["task"]
    assert params["additionalProperties"] is False
    assert set(params["properties"]) == {"task", "model", "reasoning", "files"}
    assert params["properties"]["model"]["enum"] == ["fast", "strong"]
    assert params["properties"]["model"]["default"] == "strong"
    assert params["properties"]["reasoning"]["enum"] == ["low", "medium", "high"]


def test_muse_and_worker_get_it_subworker_does_not() -> None:
    assert _offered(CHAT, _spec("worker", "goal", "teacher")) == ["start_helper"]
    assert h.helper_type_for(_spec("worker", "goal", "teacher")) == "worker"
    assert _offered(CHAT, _spec("subworker")) == ["start_helper"]
    assert h.helper_type_for(_spec("subworker")) == "subworker"
    assert _offered(CHAT, _spec()) == []
    assert _offered(None, _spec("worker")) == []


def test_bundle_surfaces() -> None:
    bundle = REPO / "infra/omnigent/agents/nova-claude"
    muse = yaml.safe_load((bundle / "config.yaml").read_text())["tools"]["allow"]
    worker = yaml.safe_load((bundle / "agents/worker/config.yaml").read_text())["tools"]["allow"]
    sub = yaml.safe_load((bundle / "agents/worker/agents/subworker/config.yaml").read_text())[
        "tools"
    ]["allow"]
    assert "start_helper" in muse
    assert "sys_session_send" not in muse
    assert "sys_session_get_info" in muse
    assert "start_helper" in worker
    assert "sys_session_send" not in worker
    assert "start_helper" not in sub


# ── title ──────────────────────────────────────────────────────────────────


def test_title_is_first_words_in_sentence_case_never_a_slug() -> None:
    title = h.helper_title("compare notes apps: Notion vs Obsidian vs Bear for a team", set())
    assert title is not None
    assert title[0].isupper()
    assert "-" not in title.split()[0]
    assert ":" not in title
    assert len(title) <= 48


def test_title_is_unique_among_siblings() -> None:
    assert h.helper_title("Compare notes apps", {"compare notes apps"}) == "Compare notes apps 2"
    assert h.helper_title("Compare notes apps", set()) == "Compare notes apps"


# ── handler: translation and dedup ─────────────────────────────────────────


def _host(
    spec: Any,
    calls: list[SpawnRequest],
    rows: list[str] | None = None,
    refuse: str | None = None,
) -> SubAgentHost:
    async def spawn(request: SpawnRequest) -> SpawnResult:
        calls.append(request)
        await asyncio.sleep(0.01)
        return SpawnResult(error=refuse) if refuse else SpawnResult(child_id=f"conv_{len(calls)}")

    async def titles() -> list[str]:
        return rows or []

    return SubAgentHost(
        declared_types=tuple(sub.name for sub in spec.sub_agents),
        child_titles=titles,
        spawn=spawn,
    )


@pytest.fixture
def dispatched() -> list[SpawnRequest]:
    h._recent.clear()
    h._locks.clear()
    return []


def _ctx(
    calls: list[SpawnRequest], spec: Any = None, conv: str = "conv_chat", **host_kw: Any
) -> HandlerCtx:
    return HandlerCtx(
        "start_helper",
        object(),  # type: ignore[arg-type]
        conv,
        CHAT,
        sub_agents=_host(spec or _spec("worker"), calls, **host_kw),
    )


async def test_receipt_text_differs_by_caller(dispatched: list[SpawnRequest]) -> None:
    muse = json.loads(
        await h.handle_start_helper(_ctx(dispatched), {"task": "Compare notes apps"})
    )
    assert "end your turn" in muse["message"]
    assert "one sentence" in muse["message"]
    part = json.loads(
        await h.handle_start_helper(
            _ctx(dispatched, _spec("subworker"), "conv_coord"), {"task": "Qdrant"}
        )
    )
    assert "tell the person" not in part["message"].lower()
    assert "write the deliverable yourself" in part["message"]
    assert "one sentence" not in part["message"]


async def test_call_becomes_the_create_path_request(dispatched: list[SpawnRequest]) -> None:
    out = await h.handle_start_helper(
        _ctx(dispatched),
        {"task": "Compare notes apps", "reasoning": "high", "files": ["file_1"]},
    )
    receipt = json.loads(out)
    assert receipt["started"] is True
    assert receipt["helper_id"] == "conv_1"
    assert "end your turn" in receipt["message"]
    assert dispatched == [
        SpawnRequest(
            agent="worker",
            task="Compare notes apps",
            title="Compare notes apps",
            model="strong",
            reasoning_effort="high",
            file_ids=("file_1",),
        )
    ]


async def test_title_avoids_existing_children(dispatched: list[SpawnRequest]) -> None:
    await h.handle_start_helper(
        _ctx(dispatched, rows=["worker: Compare notes apps"]), {"task": "Compare notes apps"}
    )
    assert dispatched[0].title == "Compare notes apps 2"


async def test_coordinator_starts_its_subworker(dispatched: list[SpawnRequest]) -> None:
    await h.handle_start_helper(
        _ctx(dispatched, _spec("subworker")), {"task": "Part one", "model": "fast"}
    )
    assert (dispatched[0].agent, dispatched[0].model) == ("subworker", "fast")


async def test_same_task_twice_in_parallel_starts_one_helper(
    dispatched: list[SpawnRequest],
) -> None:
    a, b = await asyncio.gather(
        h.handle_start_helper(_ctx(dispatched), {"task": "Compare notes apps"}),
        h.handle_start_helper(_ctx(dispatched), {"task": "  compare   NOTES apps "}),
    )
    assert a == b
    assert len(dispatched) == 1


async def test_other_task_or_other_chat_or_later_starts_another(
    dispatched: list[SpawnRequest], monkeypatch: pytest.MonkeyPatch
) -> None:
    await h.handle_start_helper(_ctx(dispatched), {"task": "One"})
    await h.handle_start_helper(_ctx(dispatched), {"task": "Two"})
    await h.handle_start_helper(_ctx(dispatched, conv="conv_other"), {"task": "One"})
    assert len(dispatched) == 3
    monkeypatch.setattr(h, "DEDUP_WINDOW_S", -1.0)
    await h.handle_start_helper(_ctx(dispatched), {"task": "One"})
    assert len(dispatched) == 4


async def test_stale_dedup_entries_and_idle_chat_locks_are_pruned(
    dispatched: list[SpawnRequest], monkeypatch: pytest.MonkeyPatch
) -> None:
    await h.handle_start_helper(_ctx(dispatched, conv="conv_old"), {"task": "One"})
    assert "conv_old" in h._locks
    monkeypatch.setattr(h, "DEDUP_WINDOW_S", -1.0)
    await h.handle_start_helper(_ctx(dispatched, conv="conv_new"), {"task": "One"})
    assert set(h._locks) == {"conv_new"}
    assert {chat for chat, _ in h._recent} == {"conv_new"}


async def test_refusal_is_not_cached_and_names_the_right_tool(
    dispatched: list[SpawnRequest],
) -> None:
    out = await h.handle_start_helper(
        _ctx(dispatched, refuse="sub-agent concurrency cap reached"), {"task": "One"}
    )
    assert out == "Error: start_helper: sub-agent concurrency cap reached"
    assert not h._recent


@pytest.mark.parametrize(
    ("args", "mention"),
    [
        ({"task": "x", "title": "y"}, "does not take title"),
        ({"task": " "}, "requires a non-empty 'task'"),
        ({"task": "x", "model": "gpt"}, "'model' must be one of fast, strong"),
        ({"task": "x", "reasoning": "ultra"}, "'reasoning' must be one of low, medium, high"),
        ({"task": "x", "files": "file_1"}, "'files' must be a list of uploaded file ids"),
    ],
)
async def test_bad_input_is_refused_up_front_in_start_helper_terms(
    dispatched: list[SpawnRequest], args: dict[str, Any], mention: str
) -> None:
    out = await h.handle_start_helper(_ctx(dispatched), args)
    assert out == f"Error: start_helper: {mention}"
    assert not dispatched


def test_tool_schema_uses_the_shared_choices() -> None:
    props = StartHelperTool().get_schema()["function"]["parameters"]["properties"]
    assert tuple(props["model"]["enum"]) == HELPER_MODEL_CHOICES
    assert tuple(props["reasoning"]["enum"]) == HELPER_EFFORT_CHOICES


# ── the result carries the Helper's files ──────────────────────────────────


def _save(session: str, artifact_id: str, name: str, version: int = 1) -> None:
    sf.record_saved_file(
        session,
        json.dumps({"type": "artifact", "id": artifact_id, "name": name, "version": version}),
    )


def test_files_of_helper_and_its_helpers_reach_the_notice() -> None:
    sf._saved.clear()
    _save("conv_worker", "a1", "report.html")
    _save("conv_sub", "a2", "table.csv")
    sf.record_saved_file("conv_worker", json.dumps({"error": "nope"}))
    tree = {"conv_worker": ["conv_sub"]}
    files = sf.collect_saved_files("conv_worker", lambda s: tree.get(s, []))
    assert {f["id"] for f in files} == {"a1", "a2"}
    notice = format_subagent_wake_notice_with_result(
        agent="worker",
        title="Compare",
        status="completed",
        child_session_id="conv_worker",
        result_text="Done",
        saved_files=sf.format_saved_files(files),
    )
    assert "artifact_id a1" in notice
    assert "artifact_id a2" in notice
    assert "report.html" in notice
    assert "Never write a file card without its artifact_id" in notice


def test_resave_keeps_newest_version_and_no_files_adds_nothing() -> None:
    sf._saved.clear()
    _save("conv_w", "a1", "r.html")
    _save("conv_w", "a9", "r.html", version=2)
    files = sf.collect_saved_files("conv_w", lambda _s: [])
    assert [f["id"] for f in files] == ["a9"]
    assert sf.format_saved_files([]) == ""


def test_file_card_accepts_the_artifact_id() -> None:
    card = build_card(
        {
            "card": "file",
            "data": {"name": "r.html", "artifactId": "a1", "version": 2},
            "fallback": "Saved r.html",
        }
    )
    assert card["data"]["artifactId"] == "a1"


def test_forget_drops_the_helper_and_its_helpers_files() -> None:
    sf._saved.clear()
    _save("conv_worker", "a1", "report.html")
    _save("conv_sub", "a2", "table.csv")
    _save("conv_other", "a3", "keep.csv")
    tree = {"conv_worker": ["conv_sub"]}
    sf.forget_saved_files("conv_worker", lambda s: tree.get(s, []))
    assert set(sf._saved) == {"conv_other"}


async def test_only_a_helpers_artifact_save_is_noted_by_the_feature_listener() -> None:
    sf._saved.clear()
    saved = json.dumps({"type": "artifact", "id": "a1", "name": "r.html"})
    helper = {**CHAT, SUBAGENT_LABEL_KEY: "worker"}

    def ctx(tool: str, labels: dict[str, str]) -> HandlerCtx:
        return HandlerCtx(tool, None, "conv_w", labels)

    notify_result(ctx("artifact_save", CHAT), saved)  # the Muse itself
    notify_result(ctx("artifact_list", helper), saved)  # another tool
    assert not sf._saved
    notify_result(ctx("artifact_save", helper), saved)
    assert sf._saved["conv_w"]["r.html"]["id"] == "a1"


def test_deleting_a_session_forgets_its_saved_files() -> None:
    from omnigent.runner.app import unregister_subagent_work_for_session

    sf._saved.clear()
    _save("conv_gone", "a1", "r.html")
    unregister_subagent_work_for_session("conv_gone")
    assert not sf._saved
