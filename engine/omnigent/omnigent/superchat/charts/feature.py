"""Registration of the charts primitive: the ``display_chart`` and ``display_dashboard`` tools."""

from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING

from omnigent.context.labels import is_superside_chat
from omnigent.superchat.charts.handlers import handle_chart_tool, handle_dashboard_tool
from omnigent.superchat.feature import Feature, ToolManagerCtx

if TYPE_CHECKING:
    from omnigent.tools.base import Tool


def _tools(labels: Mapping[str, str] | None, _ctx: ToolManagerCtx) -> list[Tool]:
    """Offered to the Super Chat and to Helpers alike (a Helper saves under its parent)."""
    from omnigent.superchat.charts.tools import DisplayChartTool, DisplayDashboardTool

    if not is_superside_chat(labels):
        return []
    return [DisplayChartTool(), DisplayDashboardTool()]


CHARTS_FEATURE = Feature(
    name="charts",
    tools=_tools,
    handlers={"display_chart": handle_chart_tool, "display_dashboard": handle_dashboard_tool},
)
