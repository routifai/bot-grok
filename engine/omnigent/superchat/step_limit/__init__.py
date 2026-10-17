"""Step limit: a Conversation turn may make a few work tool calls, then hands off to a Helper.

Layout: ``policy`` (the counter policy). It is a policy, not a tool; the engine installs it on
Super Chat sessions (see ``omnigent.runtime.policies.builder``).
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING

from omnigent.superchat.feature import Feature, ToolManagerCtx

if TYPE_CHECKING:
    from omnigent.tools.base import Tool


def _tools(_labels: Mapping[str, str] | None, _ctx: ToolManagerCtx) -> list[Tool]:
    """The step limit is a policy, not a tool."""
    return []


FEATURE = Feature(name="step_limit", tools=_tools)
