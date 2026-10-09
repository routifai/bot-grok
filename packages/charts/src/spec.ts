/* Portions modified from getnao/nao apps/shared/src/tools/display-chart.ts@5bde830, Apache-2.0; changes: zod 4, `query_id` replaced by a result-file `source`, table and custom chart types dropped. */
import * as z from "zod";

import { BUILTIN_CHART_TYPES, type ChartType } from "./chart-types.js";

export const ChartTypeEnum = z.enum(BUILTIN_CHART_TYPES);

const ChartTypeSchema = ChartTypeEnum;

export const XAxisTypeEnum = z.enum(["date", "number", "category"]);

export const ValueFormatSchema = z.object({
  d3_format: z
    .string()
    .describe(
      'd3-format specifier applied to the number as-is, such as ",.2f", ".1f", ",.0f", or ".2s". Do not use d3\'s "%" type: for a percentage already stored as 42.5, use { d3_format: ".1f", suffix: "%" } so the value is not multiplied by 100.',
    )
    .optional(),
  compact: z
    .enum(["financial", "si"])
    .describe(
      'How d3 SI-prefix "s" output is displayed. Defaults to "financial", which maps k to K and G to B while leaving M and T unchanged. Use "si" for scientific units such as bytes so d3 letters remain unchanged.',
    )
    .optional(),
  prefix: z
    .string()
    .describe(
      'Free text placed before the number. Use for any currency symbol, such as "$", "€", "¥", or "£". Example USD money: { d3_format: ",.2f", prefix: "$", compact: "financial" }.',
    )
    .optional(),
  suffix: z
    .string()
    .describe(
      'Free text placed after the number. Use for percentages and any unit. Examples: { d3_format: ".1f", suffix: "%" } for 42.5 as 42.5%; { d3_format: ",.0f", suffix: " V" } for volts; { d3_format: ".2s", suffix: "B", compact: "si" } for bytes.',
    )
    .optional(),
});

export const ComparisonModeEnum = z.enum(["percentage", "variation", "absolute", "none"]);
export type ComparisonMode = z.infer<typeof ComparisonModeEnum>;

const COMPARISON_MODE_DESCRIPTION =
  'KPI cards only: shows a change pill comparing the latest value to the previous period ("percentage", "variation", "absolute", or "none" to hide). Requires the query to return 2+ time-ordered rows (oldest → newest).';
export const SeriesTypeEnum = z.enum(["bar", "line", "area"]);

export const YAxisSideEnum = z.enum(["left", "right"]);

/** A CSS color a series may use: hex, rgb(), hsl(), a plain name or a `--chart-N` token. Same pattern in the engine. */
export const CHART_COLOR_PATTERN =
  "^(#[0-9a-fA-F]{3,8}|rgba?\\([0-9.,%\\s/]{1,48}\\)|hsla?\\([0-9.,%\\sdeg/]{1,48}\\)|[a-zA-Z]{3,24}|var\\(--chart-[1-8]\\))$";
export const ChartColorSchema = z.string().max(64).regex(new RegExp(CHART_COLOR_PATTERN));

export const SeriesConfigSchema = z.object({
  data_key: z.string().describe("Column name from the result file to plot."),
  color: ChartColorSchema.describe("CSS color (defaults to theme colors).").optional(),
  label: z.string().describe("Label to display in the legend.").optional(),
  value_format: ValueFormatSchema.describe(
    'Controls how this series\' numeric values render on the axis, tooltip, data labels, and KPI card. The number is formatted as-is: use prefix for any currency symbol and suffix for percentages or units; never use d3\'s "%" type because it multiplies by 100. Examples: USD { d3_format: ",.2f", prefix: "$", compact: "financial" }; percentage stored as 42.5 { d3_format: ".1f", suffix: "%" }; volts { d3_format: ",.0f", suffix: " V" }; bytes { d3_format: ".2s", suffix: "B", compact: "si" }.',
  ).optional(),
  is_total: z
    .boolean()
    .describe(
      "Set to true when this series is an already-aggregated total of the other series (e.g. a grand total, rollup, subtotal, or sum-of-parts column), so the tooltip must not sum it again. Decide this from the meaning of the column, not its name — it applies in any language.",
    )
    .optional(),
  series_type: SeriesTypeEnum.describe(
    'How this series is drawn ("bar", "line" or "area"). Only used when chart_type is "mixed"; defaults to "bar". Use it to combine types in one chart, e.g. bars for revenue and a line for a rate.',
  ).optional(),
  y_axis: YAxisSideEnum.describe(
    'Which Y-axis this series is plotted against ("left" or "right"). Only used when chart_type is "mixed"; defaults to "left". A right axis is drawn whenever any series uses "right" — use it to compare metrics with very different scales/units.',
  ).optional(),
});

/**
 * Where the chart's rows come from. Nova replaces nao's `query_id` (a previous `execute_sql` result) with a
 * result file in the person's Computer; the engine reads it runner-side, so the model never retypes values.
 */
export const ChartSourceSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe(
      "Path of a result file in your workspace (.csv, .tsv, .json, .jsonl or .ndjson) that your own code (pandas, duckdb) already wrote. The chart reads its rows from here; never retype data values.",
    ),
  columns: z
    .array(z.string())
    .describe(
      "Optional: the columns to keep. Defaults to the x-axis column plus every series data_key. Every name must exist in the file.",
    )
    .optional(),
  max_rows: z
    .number()
    .int()
    .min(1)
    .max(5000)
    .describe(
      "Optional: cap on rows read from the file (default 2000). Aggregate in code first; never plot raw rows.",
    )
    .optional(),
});
export type ChartSource = z.infer<typeof ChartSourceSchema>;

export const ChartInputObjectSchema = z.object({
  source: ChartSourceSchema,
  chart_type: ChartTypeSchema.describe(
    "Built-in chart type or an available project custom chart type.",
  ),
  x_axis_key: z.string().describe("Column name for X-axis/category labels."),
  x_axis_type: XAxisTypeEnum.nullable().describe(
    'Use "date" only when x-axis values parse as JS Date (YYYY-MM-DD). Use "category" for quarter_ending, fiscal periods, or labels. Use "number" for numeric x-axis.',
  ),
  x_axis_label: z
    .string()
    .describe("Title displayed alongside the X-axis. Leave unset to show no axis title.")
    .optional(),
  series: z
    .array(SeriesConfigSchema)
    .min(1)
    .describe("Columns to plot as data series (at least one series required)."),
  y_axis_min: z
    .number()
    .describe(
      "Fixes the left Y-axis lower bound. Leave unset to auto-scale for readability (line and scatter charts do not force a zero baseline).",
    )
    .optional(),
  y_axis_max: z
    .number()
    .describe("Fixes the left Y-axis upper bound. Leave unset to auto-scale.")
    .optional(),
  y_axis_label: z
    .string()
    .describe("Title displayed alongside the left Y-axis. Leave unset to show no axis title.")
    .optional(),
  y_axis_right_min: z
    .number()
    .describe(
      'Fixes the right Y-axis lower bound. Only used when chart_type is "mixed"; leave unset to auto-scale.',
    )
    .optional(),
  y_axis_right_max: z
    .number()
    .describe(
      'Fixes the right Y-axis upper bound. Only used when chart_type is "mixed"; leave unset to auto-scale.',
    )
    .optional(),
  y_axis_right_label: z
    .string()
    .describe('Label displayed alongside the right Y-axis. Only used when chart_type is "mixed".')
    .optional(),
  show_data_labels: z
    .boolean()
    .describe(
      "Show the numeric value of each data point directly on the chart. Set to true when the user asks to display values/data labels on the chart.",
    )
    .optional(),
  hide_total: z
    .boolean()
    .describe(
      'Set to true when the chart\'s series must NOT be added together into a single grand total — e.g. they are unrelated metrics, in different units, or different currencies, so a combined total would be meaningless. When true, the hover tooltip omits the "Total" row. Leave unset when the series are additive parts of the same measure (a total then makes sense). This is a chart-wide setting; for a single series that is itself an aggregated total of the others, use the per-series is_total flag instead.',
    )
    .optional(),
  title: z
    .string()
    .describe(
      "A concise and descriptive title of what the chart shows. Do not include the type of chart in the title or other chart configurations.",
    ),
});

const leftYAxisBoundsValid = (input: { y_axis_min?: number; y_axis_max?: number }) =>
  input.y_axis_min === undefined ||
  input.y_axis_max === undefined ||
  input.y_axis_min < input.y_axis_max;
const rightYAxisBoundsValid = (input: { y_axis_right_min?: number; y_axis_right_max?: number }) =>
  input.y_axis_right_min === undefined ||
  input.y_axis_right_max === undefined ||
  input.y_axis_right_min < input.y_axis_right_max;
const LEFT_Y_AXIS_BOUNDS_MESSAGE = {
  message: "The left Y-axis minimum must be less than the maximum.",
};
const RIGHT_Y_AXIS_BOUNDS_MESSAGE = {
  message: "The right Y-axis minimum must be less than the maximum.",
};

export const ChartInputSchema = ChartInputObjectSchema.refine(
  leftYAxisBoundsValid,
  LEFT_Y_AXIS_BOUNDS_MESSAGE,
).refine(rightYAxisBoundsValid, RIGHT_Y_AXIS_BOUNDS_MESSAGE);

/** KPI cards render a single headline number and have no axes, so they may omit the x-axis fields. */
const KpiCardObjectSchema = ChartInputObjectSchema.extend({
  x_axis_key: z.string().describe("Column name for X-axis/category labels.").optional(),
  x_axis_type: XAxisTypeEnum.nullable()
    .describe(
      'Use "date" only when x-axis values parse as JS Date (YYYY-MM-DD). Use "category" for quarter_ending, fiscal periods, or labels. Use "number" for numeric x-axis.',
    )
    .optional(),
  comparison_mode: ComparisonModeEnum.describe(COMPARISON_MODE_DESCRIPTION).optional(),
});
const KpiCardInputSchema = KpiCardObjectSchema.refine(
  leftYAxisBoundsValid,
  LEFT_Y_AXIS_BOUNDS_MESSAGE,
).refine(rightYAxisBoundsValid, RIGHT_Y_AXIS_BOUNDS_MESSAGE);

/** A saved chart's spec: the input without its data source (the artifact stores the rows beside it). */
export const ChartSpecSchema = KpiCardObjectSchema.omit({ source: true });
export type ChartSpec = z.infer<typeof ChartSpecSchema>;

export type ChartInput = z.infer<typeof ChartInputSchema>;
export type KpiCardInput = z.infer<typeof KpiCardInputSchema>;
export type Input = ChartInput | KpiCardInput;

export const InputSchema = z
  .union([ChartInputSchema, KpiCardInputSchema])
  .superRefine((input, context) => {
    if (
      input.chart_type !== "kpi_card" &&
      (input.x_axis_key === undefined || input.x_axis_type == null)
    ) {
      context.addIssue({
        code: "custom",
        message: "x_axis_key and x_axis_type are required for this chart type.",
      });
    }
  }) as z.ZodType<Input>;

export const OutputSchema = z.object({
  _version: z.literal("1").optional(),
  success: z.boolean(),
  error: z.string().optional(),
});

export type XAxisType = z.infer<typeof XAxisTypeEnum>;
export type ValueFormat = z.infer<typeof ValueFormatSchema>;
export type SeriesType = z.infer<typeof SeriesTypeEnum>;
export type YAxisSide = z.infer<typeof YAxisSideEnum>;
export type SeriesConfig = z.infer<typeof SeriesConfigSchema>;
export type Output = z.infer<typeof OutputSchema>;

export type BuiltinChartInput = Omit<ChartInput, "chart_type"> & { chart_type: ChartType };

export function hasRightAxisSeries(series: Pick<SeriesConfig, "y_axis">[]): boolean {
  return series.some((s) => s.y_axis === "right");
}
