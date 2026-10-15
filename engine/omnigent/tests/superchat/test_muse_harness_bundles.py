"""The Muse's harness flag (SUPERCHAT_MUSE_HARNESS): two bundles rendered from one template set."""

from __future__ import annotations

import difflib
import filecmp
import os
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[4]
AGENTS = REPO / "infra/omnigent/agents"
CLAUDE = AGENTS / "superchat-claude"
PI = AGENTS / "superchat-pi"


def _lines(path: Path) -> list[str]:
    return path.read_text().splitlines()


def test_pi_bundle_differs_from_default_only_in_harness_keys() -> None:
    diff = [
        line
        for line in difflib.unified_diff(
            _lines(CLAUDE / "config.yaml"), _lines(PI / "config.yaml"), lineterm="", n=0
        )
        if line[0] in "+-" and not line.startswith(("+++", "---"))
    ]
    assert diff == [
        "-name: superchat-claude",
        "+name: superchat-pi",
        "+skills: none",
        "-    harness: claude-sdk",
        "+    harness: pi",
        "+    context_files: false",
        "+    system_prompt_mode: replace",
    ]


HELPERS = ("worker", "worker/agents/subworker", "notes")
PI_KEYS = ("context_files: false", "system_prompt_mode: replace", "skills: none")


def test_prompt_is_identical_and_helpers_have_the_same_files() -> None:
    assert (CLAUDE / "AGENTS.md").read_text() == (PI / "AGENTS.md").read_text()
    cmp = filecmp.dircmp(CLAUDE / "agents", PI / "agents")
    assert cmp.left_only == cmp.right_only == []


@pytest.mark.parametrize("helper", HELPERS)
def test_the_switch_is_total_every_helper_runs_on_the_bundles_harness(helper: str) -> None:
    claude = (CLAUDE / "agents" / helper / "config.yaml").read_text()
    pi = (PI / "agents" / helper / "config.yaml").read_text()
    assert "harness: claude-sdk" in claude
    assert "harness: pi" not in claude
    assert not any(key in claude for key in PI_KEYS)
    assert "harness: pi" in pi
    assert "claude-sdk" not in pi
    # The same pi keys as the Muse: one definition, rendered into every Type.
    assert all(key in pi for key in PI_KEYS)


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_committed_bundles_match_a_fresh_render(tmp_path: Path) -> None:
    env = {**os.environ, "SUPERCHAT_RENDER_AGENTS_DIR": str(tmp_path)}
    subprocess.run(
        ["node", str(REPO / "infra/omnigent/render-agents.mjs")],
        check=True,
        env=env,
        capture_output=True,
    )
    for name in ("superchat-claude", "superchat-pi"):
        cmp = filecmp.dircmp(AGENTS / name, tmp_path / name)
        assert cmp.diff_files == cmp.left_only == cmp.right_only == [], name
        for sub in cmp.subdirs.values():
            assert sub.diff_files == sub.left_only == sub.right_only == [], name


@pytest.mark.parametrize(
    ("name", "harness"), [("superchat-claude", "claude-sdk"), ("superchat-pi", "pi")]
)
def test_spec_loader_loads_both_bundles(
    name: str, harness: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    from omnigent.spec import parse

    monkeypatch.setenv("TAVILY_API_KEY", "x")
    spec = parse(AGENTS / name)
    # No model is named: a session runs on the model picked from its connection.
    assert spec.executor.model is None
    assert spec.executor.config["harness"] == harness
    # ``notes`` is started by the engine for the daily-note passes, never by start_helper.
    assert {a.name for a in spec.sub_agents} == {"worker", "notes"}
    worker = next(a for a in spec.sub_agents if a.name == "worker")
    for sub in [*spec.sub_agents, *worker.sub_agents]:
        assert sub.executor.config["harness"] == harness, sub.name
    if harness == "pi":
        assert spec.executor.config["context_files"] is False
        assert spec.executor.config["system_prompt_mode"] == "replace"
        assert spec.skills_filter == "none"
        for sub in [*spec.sub_agents, *worker.sub_agents]:
            assert sub.executor.config["context_files"] is False, sub.name
            assert sub.executor.config["system_prompt_mode"] == "replace", sub.name
            assert sub.skills_filter == "none", sub.name


@pytest.mark.parametrize("bundle", [CLAUDE, PI], ids=["claude", "pi"])
def test_the_muse_may_call_its_reply_tools(bundle: Path) -> None:
    # A feature tool missing from the Muse's allow list is invisible to it.
    allow = {line.strip().removeprefix("- ") for line in _lines(bundle / "config.yaml")}
    for name in ("render_card", "ask_clarification", "suggest_follow_ups"):
        assert name in allow, name
    # Charts and dashboards are pages built in the Computer; the retired JSON chart tools stay out.
    assert not {"display_chart", "display_dashboard"} & allow


@pytest.mark.parametrize("bundle", [CLAUDE, PI], ids=["claude", "pi"])
def test_only_the_muse_may_close_a_working_list_line(bundle: Path) -> None:
    def allowed(path: Path) -> set[str]:
        return {line.strip().removeprefix("- ") for line in _lines(path)}

    assert "state_close" in allowed(bundle / "config.yaml")
    for helper in ("worker", "notes"):
        names = allowed(bundle / "agents" / helper / "config.yaml")
        assert "state_close" not in names
    worker_names = allowed(bundle / "agents" / "worker" / "config.yaml")
    # The worker reads memory/ with the file tools; it gains no tool that writes the notes.
    assert not {"daily_note_update", "memory_remember", "memory_forget"} & worker_names


@pytest.mark.parametrize("bundle", [CLAUDE, PI], ids=["claude", "pi"])
def test_prompts_point_at_the_memory_folder(bundle: Path) -> None:
    muse = (bundle / "AGENTS.md").read_text()
    assert "use `recall` before you answer" in muse and "`recall_get`" in muse
    assert "`state_close`" in muse
    assert "Never edit it or the journal" in muse
    worker = (bundle / "agents/worker/config.yaml").read_text()
    assert "`memory/STATE.md` holds" in worker and "Never write there" in worker
