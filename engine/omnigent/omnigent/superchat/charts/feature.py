"""Registration of the charts primitive: the ``display_chart`` tool."""

from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING

from omnigent.context.labels import is_superside_chat
from omnigent.superchat.charts.handlers import handle_chart_tool
from omnigent.superchat.charts.tools import CHART_TOOL_NAMES
from omnigent.superchat.feature import Feature, ToolManagerCtx

if TYPE_CHECKING:
    from omnigent.tools.base import Tool


def _tools(labels: Mapping[str, str] | None, _ctx: ToolManagerCtx) -> list[Tool]:
    """Offered to the Super Chat and to Helpers alike (a Helper saves under its parent)."""
    from omnigent.superchat.charts.tools import DisplayChartTool

    if not is_superside_chat(labels):
        return []
    return [DisplayChartTool()]


CHARTS_FEATURE = Feature(
    name="charts",
    tools=_tools,
    handlers=dict.fromkeys(CHART_TOOL_NAMES, handle_chart_tool),
)
