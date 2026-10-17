import re
from pathlib import Path

from omnigent.runtime.prompt import build_instructions
from omnigent.spec import load
from omnigent.tools.builtins.load_skill import LoadSkillTool

_AGENT = Path(__file__).resolve().parents[2] / "dev" / "resolve-agent"


def test_resolve_startup_prompt_routes_to_procedures_without_inlining_them() -> None:
    spec = load(_AGENT)
    tool = LoadSkillTool(spec.skills, skills_filter="none")
    prompt = build_instructions(spec, None, [tool.get_schema()])

    assert len(prompt.split()) < 1500
    assert spec.skills
    for skill in spec.skills:
        assert skill.name in prompt
        assert skill.content not in prompt
    assert "reproduction-driven work, complete" in prompt
    assert "`resolve-repro-audit` before the existing-fix search" in prompt
    assert "Before every interim or final handoff" in prompt


def test_resolve_markdown_links_resolve_from_their_own_directory() -> None:
    # Moving procedures into nested skills must keep relative links pointing at real files.
    broken = []
    for document in sorted(_AGENT.rglob("*.md")):
        for target in re.findall(r"\]\(([^)\s]+)\)", document.read_text()):
            if re.match(r"[a-z][a-z0-9+.-]*:|#|/", target):
                continue
            if not (document.parent / target.split("#")[0]).exists():
                broken.append(f"{document.relative_to(_AGENT)} -> {target}")
    assert not broken
