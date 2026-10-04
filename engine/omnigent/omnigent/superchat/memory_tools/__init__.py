"""``memory_*`` tools: the model's handle on long-term memory.

Only the tool defs and the runner handler live here; the memory core stays in ``omnigent.memory``
(service, store, upkeep) and its server routes in ``omnigent.server.routes.session_memory``.
Layout: ``tools`` (tool defs), ``handlers`` (runner side).
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING

from omnigent.context.labels import uses_omnigent_context
from omnigent.superchat.feature import Feature, ToolManagerCtx
from omnigent.superchat.memory_tools.handlers import handle_memory_tool

if TYPE_CHECKING:
    from omnigent.tools.base import Tool

MEMORY_TOOL_NAMES = (
    "memory_remember",
    "memory_search",
    "memory_get",
    "memory_explain",
    "memory_forget",
)


def _tools(labels: Mapping[str, str] | None, _ctx: ToolManagerCtx) -> list[Tool]:
    """Every rollover or superside-chat session gets long-term memory (same gate as history)."""
    from omnigent.superchat.memory_tools.tools import (
        MemoryExplainTool,
        MemoryForgetTool,
        MemoryGetTool,
        MemoryRememberTool,
        MemorySearchTool,
    )

    if not uses_omnigent_context(labels):
        return []
    return [
        MemoryRememberTool(),
        MemorySearchTool(),
        MemoryGetTool(),
        MemoryExplainTool(),
        MemoryForgetTool(),
    ]


FEATURE = Feature(
    name="memory_tools",
    tools=_tools,
    handlers=dict.fromkeys(MEMORY_TOOL_NAMES, handle_memory_tool),
)
