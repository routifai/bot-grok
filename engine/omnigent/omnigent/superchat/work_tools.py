"""Which tool calls count as the Muse doing work (step limit and Activity feed share this)."""

from __future__ import annotations

# Artifact tools that only read never count.
_FREE_ARTIFACT_TOOLS = frozenset({"artifact_list"})


def is_work_tool(name: str) -> bool:
    """Whether a tool call counts as work (``mcp__<server>__`` prefixes are ignored).

    Search/fetch, browser, shell and files, artifact writes and Computer actions are work;
    memory, cards, Goals, scheduling, vault and Helper management are not.
    """
    base = name.rsplit("__", 1)[-1] if name.startswith("mcp__") else name
    if base in _FREE_ARTIFACT_TOOLS:
        return False
    return (
        base in ("web_search", "web_fetch")
        or base.startswith(("browser_", "sys_os_", "artifact_"))
        or "computer" in name
    )
