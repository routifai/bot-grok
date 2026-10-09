"""The ``display_chart`` input as pydantic: the chart spec the Muse fills in.

Portions modified from getnao/nao apps/shared/src/tools/display-chart.ts@5bde830, Apache-2.0;
changes: ported from zod to pydantic with the LLM-tuned field descriptions kept as they are,
``query_id`` (a previous ``execute_sql`` result) replaced by ``source`` (a result file in the
person's Computer), the table and custom chart types dropped. The web twin is
``packages/charts/src/spec.ts``.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

CHART_TYPES = (
    "bar",
    "stacked_bar",
    "stacked_bar_100",
    "horizontal_bar",
    "horizontal_bar_100",
    "line",
    "area",
    "stacked_area",
    "stacked_area_100",
    "mixed",
    "pie",
    "donut",
    "kpi_card",
    "scatter",
    "radar",
)
ChartType = Literal[
    "bar",
    "stacked_bar",
    "stacked_bar_100",
    "horizontal_bar",
    "horizontal_bar_100",
    "line",
    "area",
    "stacked_area",
    "stacked_area_100",
    "mixed",
    "pie",
    "donut",
    "kpi_card",
    "scatter",
    "radar",
]

#: Rows kept in the chart's data snapshot when the call gives no ``max_rows``.
DEFAULT_MAX_ROWS = 2000
MAX_ROWS_LIMIT = 5000

CHART_TYPE_GUIDE = (
    "Type of chart. Pick by the question: trend over time -> 'line' (several series), 'area' "
    "(one series, volume) or 'stacked_area' (parts of a whole over time); compare categories -> "
    "'bar' ('horizontal_bar' when there are many or long labels, 'stacked_bar' for parts per "
    "category, the *_100 variants for composition shares); share of one whole -> 'pie' or "
    "'donut' (at most 6 slices, one series); two metrics with different scales or units -> "
    "'mixed' (bars for the amount, a line on the right axis for the rate); one headline "
    "number -> 'kpi_card' (with comparison_mode when the rows are time-ordered); relationship "
    "between two numeric columns -> 'scatter'; profile across a few dimensions -> 'radar'."
)

#: Same pattern as ``CHART_COLOR_PATTERN`` in packages/charts/src/spec.ts: nothing that could break
#: out of an SVG attribute.
CHART_COLOR_PATTERN = (
    r"^(#[0-9a-fA-F]{3,8}|rgba?\([0-9.,%\s/]{1,48}\)|hsla?\([0-9.,%\sdeg/]{1,48}\)"
    r"|[a-zA-Z]{3,24}|var\(--chart-[1-8]\))$"
)

_MIXED_DESC = 'Only used when chart_type is "mixed"'


class ValueFormat(BaseModel):
    """How a series' numbers render on the axis, tooltip, data labels and KPI card."""

    model_config = ConfigDict(extra="forbid")

    d3_format: str | None = Field(
        default=None,
        description=(
            'd3-format specifier applied to the number as-is, such as ",.2f", ".1f", ",.0f", or '
            '".2s". Do not use d3\'s "%" type: for a percentage already stored as 42.5, use '
            '{ d3_format: ".1f", suffix: "%" } so the value is not multiplied by 100.'
        ),
    )
    compact: Literal["financial", "si"] | None = Field(
        default=None,
        description=(
            'How d3 SI-prefix "s" output is displayed. Defaults to "financial", which maps k to '
            'K and G to B while leaving M and T unchanged. Use "si" for scientific units such as '
            "bytes so d3 letters remain unchanged."
        ),
    )
    prefix: str | None = Field(
        default=None,
        description=(
            "Free text placed before the number. Use for any currency symbol, such as "
            '"$", "€", "¥", or "£". Example USD money: { d3_format: ",.2f", prefix: "$", '
            'compact: "financial" }.'
        ),
    )
    suffix: str | None = Field(
        default=None,
        description=(
            "Free text placed after the number. Use for percentages and any unit. Examples: "
            '{ d3_format: ".1f", suffix: "%" } for 42.5 as 42.5%; { d3_format: ",.0f", '
            'suffix: " V" } for volts; { d3_format: ".2s", suffix: "B", compact: "si" } for bytes.'
        ),
    )


class SeriesConfig(BaseModel):
    """One column of the result file plotted as a series."""

    model_config = ConfigDict(extra="forbid")

    data_key: str = Field(description="Column name from the result file to plot.")
    color: str | None = Field(
        default=None,
        max_length=64,
        pattern=CHART_COLOR_PATTERN,
        description="CSS color: hex, rgb(), hsl() or a color name (defaults to theme colors).",
    )
    label: str | None = Field(default=None, description="Label to display in the legend.")
    value_format: ValueFormat | None = Field(
        default=None,
        description=(
            "Controls how this series' numeric values render on the axis, tooltip, data labels, "
            "and KPI card. The number is formatted as-is: use prefix for any currency symbol and "
            'suffix for percentages or units; never use d3\'s "%" type because it multiplies by '
            '100. Examples: USD { d3_format: ",.2f", prefix: "$", compact: "financial" }; '
            'percentage stored as 42.5 { d3_format: ".1f", suffix: "%" }; volts '
            '{ d3_format: ",.0f", suffix: " V" }; bytes { d3_format: ".2s", suffix: "B", '
            'compact: "si" }.'
        ),
    )
    is_total: bool | None = Field(
        default=None,
        description=(
            "Set to true when this series is an already-aggregated total of the other series "
            "(e.g. a grand total, rollup, subtotal, or sum-of-parts column), so the tooltip must "
            "not sum it again. Decide this from the meaning of the column, not its name — it "
            "applies in any language."
        ),
    )
    series_type: Literal["bar", "line", "area"] | None = Field(
        default=None,
        description=(
            f'How this series is drawn ("bar", "line" or "area"). {_MIXED_DESC}; defaults to '
            '"bar". Use it to combine types in one chart, e.g. bars for revenue and a line for '
            "a rate."
        ),
    )
    y_axis: Literal["left", "right"] | None = Field(
        default=None,
        description=(
            'Which Y-axis this series is plotted against ("left" or "right"). '
            f'{_MIXED_DESC}; defaults to "left". A right axis is drawn whenever any series uses '
            '"right" — use it to compare metrics with very different scales/units.'
        ),
    )


class ChartSource(BaseModel):
    """Where the chart's rows come from: a result file the model's own code wrote."""

    model_config = ConfigDict(extra="forbid")

    path: str = Field(
        min_length=1,
        description=(
            "Path of a result file in your workspace (.csv, .tsv, .json, .jsonl or .ndjson) that "
            "your own code (pandas, duckdb) already wrote. The chart reads its rows from here; "
            "never retype data values."
        ),
    )
    columns: list[str] | None = Field(
        default=None,
        description=(
            "Optional: the columns to keep. Defaults to the x-axis column plus every series "
            "data_key. Every name must exist in the file."
        ),
    )
    max_rows: int | None = Field(
        default=None,
        ge=1,
        le=MAX_ROWS_LIMIT,
        description=(
            f"Optional: cap on rows read from the file (default {DEFAULT_MAX_ROWS}). Aggregate "
            "in code first; never plot raw rows."
        ),
    )


class ChartSpec(BaseModel):
    """The chart itself, without its data source (this is what the artifact stores)."""

    model_config = ConfigDict(extra="forbid")

    chart_type: ChartType = Field(description=CHART_TYPE_GUIDE)
    title: str = Field(
        min_length=1,
        description=(
            "A concise and descriptive title of what the chart shows. Do not include the type "
            "of chart in the title or other chart configurations."
        ),
    )
    x_axis_key: str | None = Field(
        default=None,
        description=(
            "Column name for X-axis/category labels. Required for every chart type except "
            "kpi_card."
        ),
    )
    x_axis_type: Literal["date", "number", "category"] | None = Field(
        default=None,
        description=(
            'Use "date" only when x-axis values parse as JS Date (YYYY-MM-DD). Use "category" '
            'for quarter_ending, fiscal periods, or labels. Use "number" for numeric x-axis. '
            "Required for every chart type except kpi_card."
        ),
    )
    x_axis_label: str | None = Field(
        default=None,
        description="Title displayed alongside the X-axis. Leave unset to show no axis title.",
    )
    series: list[SeriesConfig] = Field(
        min_length=1,
        description="Columns to plot as data series (at least one series required).",
    )
    y_axis_min: float | None = Field(
        default=None,
        description=(
            "Fixes the left Y-axis lower bound. Leave unset to auto-scale for readability (line "
            "and scatter charts do not force a zero baseline)."
        ),
    )
    y_axis_max: float | None = Field(
        default=None, description="Fixes the left Y-axis upper bound. Leave unset to auto-scale."
    )
    y_axis_label: str | None = Field(
        default=None,
        description=(
            "Title displayed alongside the left Y-axis. Leave unset to show no axis title."
        ),
    )
    y_axis_right_min: float | None = Field(
        default=None,
        description=(
            f"Fixes the right Y-axis lower bound. {_MIXED_DESC}; leave unset to auto-scale."
        ),
    )
    y_axis_right_max: float | None = Field(
        default=None,
        description=(
            f"Fixes the right Y-axis upper bound. {_MIXED_DESC}; leave unset to auto-scale."
        ),
    )
    y_axis_right_label: str | None = Field(
        default=None,
        description=f"Label displayed alongside the right Y-axis. {_MIXED_DESC}.",
    )
    show_data_labels: bool | None = Field(
        default=None,
        description=(
            "Show the numeric value of each data point directly on the chart. Set to true when "
            "the user asks to display values/data labels on the chart."
        ),
    )
    hide_total: bool | None = Field(
        default=None,
        description=(
            "Set to true when the chart's series must NOT be added together into a single grand "
            "total — e.g. they are unrelated metrics, in different units, or different "
            "currencies, so a combined total would be meaningless. When true, the hover tooltip "
            'omits the "Total" row. Leave unset when the series are additive parts of the same '
            "measure (a total then makes sense). This is a chart-wide setting; for a single "
            "series that is itself an aggregated total of the others, use the per-series "
            "is_total flag instead."
        ),
    )
    comparison_mode: Literal["percentage", "variation", "absolute", "none"] | None = Field(
        default=None,
        description=(
            "KPI cards only: shows a change pill comparing the latest value to the previous "
            'period ("percentage", "variation", "absolute", or "none" to hide). Requires the '
            "result file to hold 2+ time-ordered rows (oldest -> newest)."
        ),
    )

    @model_validator(mode="after")
    def _check(self) -> ChartSpec:
        if self.chart_type != "kpi_card" and (self.x_axis_key is None or self.x_axis_type is None):
            raise ValueError("x_axis_key and x_axis_type are required for this chart type")
        if self.y_axis_min is not None and self.y_axis_max is not None:
            if self.y_axis_min >= self.y_axis_max:
                raise ValueError("The left Y-axis minimum must be less than the maximum")
        if self.y_axis_right_min is not None and self.y_axis_right_max is not None:
            if self.y_axis_right_min >= self.y_axis_right_max:
                raise ValueError("The right Y-axis minimum must be less than the maximum")
        if self.chart_type in ("pie", "donut") and len(self.series) != 1:
            raise ValueError("A pie or donut chart takes exactly one series")
        return self


class DisplayChartInput(ChartSpec):
    """The whole ``display_chart`` call: the chart plus where its rows come from."""

    source: ChartSource
    name: str | None = Field(
        default=None,
        description=(
            "Optional short file name for the chart. Reuse the name of a chart you already "
            "displayed to save a new version of it instead of a new chart."
        ),
    )


def _simplify(node: Any, defs: dict[str, Any]) -> Any:
    """Inline ``$ref``s, drop ``title``s and fold ``anyOf: [X, null]`` into ``X``."""
    if isinstance(node, list):
        return [_simplify(item, defs) for item in node]
    if not isinstance(node, dict):
        return node
    if "$ref" in node:
        return _simplify(defs[node["$ref"].rsplit("/", 1)[-1]], defs)
    any_of = node.get("anyOf")
    if isinstance(any_of, list):
        rest = [v for v in any_of if v != {"type": "null"}]
        if len(rest) == 1:
            merged = {k: v for k, v in node.items() if k != "anyOf"}
            return _simplify({**rest[0], **merged}, defs)
    out: dict[str, Any] = {}
    for key, value in node.items():
        if key in ("title", "$defs") or (key == "default" and value is None):
            continue
        if key == "properties" and isinstance(value, dict):
            # Field names are keys here: a field called ``title`` must survive.
            out[key] = {name: _simplify(sub, defs) for name, sub in value.items()}
        else:
            out[key] = _simplify(value, defs)
    return out


def display_chart_parameters() -> dict[str, Any]:
    """The tool's JSON schema: the pydantic model, with refs inlined for the provider."""
    raw = DisplayChartInput.model_json_schema()
    schema = _simplify(raw, raw.get("$defs", {}))
    schema["additionalProperties"] = False
    return schema  # type: ignore[no-any-return]
