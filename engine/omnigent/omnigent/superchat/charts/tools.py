"""Built-in tools for charts: ``display_chart`` (one chart) and ``display_dashboard`` (several
charts and KPI tiles as one artifact).

Schema-only classes: the runner dispatches them to :mod:`omnigent.superchat.charts.handlers`, which
run in the person's Computer where the result file is.
"""

from __future__ import annotations

from typing import Any

from omnigent.superchat.charts.spec import display_chart_parameters, display_dashboard_parameters
from omnigent.tools.base import Tool

CHART_TOOL_NAMES = ("display_chart", "display_dashboard")


class DisplayChartTool(Tool):
    """Chart a result file from the workspace; dispatched to the runner handler."""

    @classmethod
    def name(cls) -> str:
        """:returns: The tool name."""
        return "display_chart"

    @classmethod
    def description(cls) -> str:
        """:returns: Human-readable description of the tool."""
        return (
            "Show the person a chart of data you already computed. First compute the numbers "
            "with code (pandas or duckdb) and write the result you want to plot to a file in "
            "your workspace (.csv, .json or .jsonl: one row per x value, one column "
            "per series); then call this with `source.path` set to that file and the column "
            "names to plot. Never type data values into the call: the chart reads them from "
            "the file, and every column name is checked against it. The chart is saved to "
            "the Library and shown in the chat automatically; do not render a card for it. "
            "Saving a chart with the same `name` adds a new version. Cite the source of the "
            "data in your reply. For a dashboard or several related charts, use "
            "display_dashboard instead: one card, not a run of separate charts."
        )

    def get_schema(self) -> dict[str, Any]:
        """:returns: The OpenAI-format tool schema."""
        return {
            "type": "function",
            "function": {
                "name": self.name(),
                "description": self.description(),
                "parameters": display_chart_parameters(),
            },
        }


class DisplayDashboardTool(Tool):
    """Several charts and KPI tiles shown as one dashboard; dispatched to the runner handler."""

    @classmethod
    def name(cls) -> str:
        """:returns: The tool name."""
        return "display_dashboard"

    @classmethod
    def description(cls) -> str:
        """:returns: Human-readable description of the tool."""
        return (
            "Show the person a dashboard: headline numbers as KPI tiles and several charts, as "
            "one card. Use it whenever the person asks for a dashboard or for several related "
            "charts; a single chart is display_chart. First compute each result with code and "
            "write it to a file in your workspace (.csv, .json or .jsonl), one file per chart "
            "or tile; then call this once with every chart's spec (the display_chart spec, "
            "with its `source.path`) and the tiles' columns. Never type data values: every "
            "chart reads its file and every column name is checked. Put the most important "
            "chart first and mark the main trend `wide`. The dashboard is saved to the Library "
            "and shown in the chat automatically; do not render a card for it, and do not also "
            "call display_chart for the same charts. Saving with the same `name` adds a new "
            "version. Cite the sources in your reply."
        )

    def get_schema(self) -> dict[str, Any]:
        """:returns: The OpenAI-format tool schema."""
        return {
            "type": "function",
            "function": {
                "name": self.name(),
                "description": self.description(),
                "parameters": display_dashboard_parameters(),
            },
        }
