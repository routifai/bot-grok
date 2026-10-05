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


def test_prompt_and_helpers_are_identical_and_stay_on_claude_sdk() -> None:
    assert (CLAUDE / "AGENTS.md").read_text() == (PI / "AGENTS.md").read_text()
    cmp = filecmp.dircmp(CLAUDE / "agents", PI / "agents")
    assert cmp.left_only == cmp.right_only == cmp.diff_files == []
    for helper in ("worker", "goal", "teacher", "worker/agents/subworker"):
        assert "harness: claude-sdk" in (PI / "agents" / helper / "config.yaml").read_text()


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
    if harness == "pi":
        assert spec.executor.config["context_files"] is False
        assert spec.executor.config["system_prompt_mode"] == "replace"
        assert spec.skills_filter == "none"
