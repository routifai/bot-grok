"""The file-search guidance reaches both Muse bundles; the stitch rules do not."""

from __future__ import annotations

from pathlib import Path

import pytest

AGENTS = Path(__file__).resolve().parents[5] / "infra" / "omnigent" / "agents"
TOOLS = (
    "files_search",
    "files_vsearch",
    "files_query",
    "files_get",
    "files_multi_get",
    "files_read_page",
    "files_status",
)


@pytest.mark.parametrize("bundle", ["nova-claude", "nova-pi"])
def test_the_bundle_teaches_the_qmd_search_strategy(bundle: str) -> None:
    text = (AGENTS / bundle / "AGENTS.md").read_text()
    section = text.split("## The person's files", 1)[1].split("\n## ", 1)[0]
    for tool in TOOLS:
        assert f"`{tool}`" in section, tool
    assert "(Annual report, p. 12)" in section  # the citation rule stays
    for gone in ("still_indexing", "still being indexed", "just attached", "read it directly"):
        assert gone not in text, gone


@pytest.mark.parametrize("bundle", ["nova-claude", "nova-pi"])
def test_helpers_get_the_same_tools(bundle: str) -> None:
    for config in (
        AGENTS / bundle / "agents" / "worker" / "config.yaml",
        AGENTS / bundle / "agents" / "worker" / "agents" / "subworker" / "config.yaml",
    ):
        text = config.read_text()
        for tool in TOOLS:
            assert f"- {tool}\n" in text, (config.name, tool)
