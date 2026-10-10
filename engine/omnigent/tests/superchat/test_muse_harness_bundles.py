"""The Muse's harness flag (NOVA_MUSE_HARNESS): two bundles rendered from one template set."""

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
CLAUDE = AGENTS / "nova-claude"
PI = AGENTS / "nova-pi"


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
        "-name: nova-claude",
        "+name: nova-pi",
        "+skills: none",
        "-    harness: claude-sdk",
        "+    harness: pi",
        "+    context_files: false",
        "+    system_prompt_mode: replace",
    ]


HELPERS = ("worker", "goal", "teacher", "worker/agents/subworker")
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


@pytest.mark.parametrize("helper", ["goal", "teacher"])
def test_background_types_pin_haiku_on_claude_and_nothing_on_pi(helper: str) -> None:
    assert "model: claude-haiku-4-5" in (CLAUDE / "agents" / helper / "config.yaml").read_text()
    text = (PI / "agents" / helper / "config.yaml").read_text()
    assert "claude-haiku" not in text
    assert "\n  model:" not in text


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_committed_bundles_match_a_fresh_render(tmp_path: Path) -> None:
    env = {**os.environ, "NOVA_RENDER_AGENTS_DIR": str(tmp_path)}
    subprocess.run(
        ["node", str(REPO / "infra/omnigent/render-agents.mjs")],
        check=True,
        env=env,
        capture_output=True,
    )
    for name in ("nova-claude", "nova-pi"):
        cmp = filecmp.dircmp(AGENTS / name, tmp_path / name)
        assert cmp.diff_files == cmp.left_only == cmp.right_only == [], name
        for sub in cmp.subdirs.values():
            assert sub.diff_files == sub.left_only == sub.right_only == [], name


@pytest.mark.parametrize(("name", "harness"), [("nova-claude", "claude-sdk"), ("nova-pi", "pi")])
def test_real_loader_loads_both_bundles(
    name: str, harness: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    from omnigent.inner.loader import load_agent_def_from_path
    from omnigent.spec import parse

    monkeypatch.setenv("TAVILY_API_KEY", "x")
    monkeypatch.setenv("NOVA_CLAUDE_MODEL", "m")
    agent = load_agent_def_from_path(str(AGENTS / name))
    assert agent is not None
    spec = parse(AGENTS / name)
    assert spec.executor.config["harness"] == harness
    assert {a.name for a in spec.sub_agents} == {"worker", "goal", "teacher"}
    worker = next(a for a in spec.sub_agents if a.name == "worker")
    for sub in [*spec.sub_agents, *worker.sub_agents]:
        assert sub.executor.config["harness"] == harness, sub.name
        assert (sub.executor.model == "claude-haiku-4-5") == (
            harness == "claude-sdk" and sub.name in {"goal", "teacher"}
        ), sub.name
    if harness == "pi":
        assert spec.executor.config["context_files"] is False
        assert spec.executor.config["system_prompt_mode"] == "replace"
        assert spec.skills_filter == "none"
        for sub in [*spec.sub_agents, *worker.sub_agents]:
            assert sub.executor.config["context_files"] is False, sub.name
            assert sub.executor.config["system_prompt_mode"] == "replace", sub.name
            assert sub.skills_filter == "none", sub.name


@pytest.mark.parametrize("name", ["nova-claude", "nova-pi"])
@pytest.mark.parametrize("helper", ["worker", "subworker"])
def test_helpers_are_offered_web_search_and_web_fetch(
    name: str, helper: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The tool surface a Helper session gets (spec + Helper label) includes the web tools."""
    from omnigent.context.labels import SUBAGENT_LABEL_KEY
    from omnigent.spec import parse
    from omnigent.tools.manager import ToolManager

    monkeypatch.setenv("TAVILY_API_KEY", "x")
    monkeypatch.setenv("NOVA_CLAUDE_MODEL", "m")
    root = parse(AGENTS / name)
    worker = next(a for a in root.sub_agents if a.name == "worker")
    spec = worker if helper == "worker" else next(a for a in worker.sub_agents)
    assert spec.name == helper
    tools = ToolManager(spec, os_env_schema_only=True, labels={SUBAGENT_LABEL_KEY: "1"})
    assert {"web_search", "web_fetch"} <= set(tools.get_tool_names())


@pytest.mark.parametrize("bundle", [CLAUDE, PI], ids=["claude", "pi"])
def test_the_muse_may_call_its_reply_tools(bundle: Path) -> None:
    # A feature tool missing from the Muse's allow list is invisible to it.
    allow = {line.strip().removeprefix("- ") for line in _lines(bundle / "config.yaml")}
    for name in ("render_card", "ask_clarification", "suggest_follow_ups"):
        assert name in allow, name
    # Charts and dashboards are pages built in the Computer; the retired JSON chart tools stay out.
    assert not {"display_chart", "display_dashboard"} & allow
