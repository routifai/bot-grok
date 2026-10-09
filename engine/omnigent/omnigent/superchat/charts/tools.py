"""Built-in tool for charts: ``display_chart``.

Schema-only class: the runner dispatches it to :mod:`omnigent.superchat.charts.handlers`, which
runs in the person's Computer where the result file is.
"""

from __future__ import annotations

from typing import Any

from omnigent.superchat.charts.spec import display_chart_parameters
from omnigent.tools.base import Tool

CHART_TOOL_NAMES = ("display_chart",)


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
            "data in your reply."
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
