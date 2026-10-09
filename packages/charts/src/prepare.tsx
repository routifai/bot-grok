/* Portions modified from getnao/nao apps/backend/src/components/generate-chart.tsx@5bde830, Apache-2.0; changes: the SVG/PNG plumbing moved to the api (`features/charts`), this keeps the spec-to-chart preparation so the web view and the server render draw the same chart; Nova tokens replace the white background. */
import type React from "react";

import {
  bucketPieData,
  buildChart,
  defaultColorFor,
  labelize,
  sortByDateKey,
} from "./chart-builder.js";
import { isBuiltinChartType } from "./chart-types.js";
import {
  type DateFormatSettings,
  dateFormatForValues,
  fullDateFormatForValues,
  isIsoDateLike,
} from "./date.js";
import type { ChartSpec } from "./spec.js";

export type ChartRow = Record<string, unknown>;

export interface LegendEntry {
  label: string;
  color: string;
}

export type LegendLayout = "horizontal" | "vertical";

/** Width reserved on the right for a vertical (pie/donut) legend. */
export const VERTICAL_LEGEND_WIDTH = 200;

export interface PrepareChartOptions {
  width: number;
  height: number;
  margin?: { top?: number; right?: number; bottom?: number; left?: number };
  /** Draw the title inside the chart (server render); the web card shows it in its header. */
  renderTitle?: boolean;
  /** Tooltip, legend… placed inside the Recharts tree. */
  children?: React.ReactNode[];
  dateFormat?: DateFormatSettings | null;
  /** The chart surface color; defaults to `var(--background)`. */
  backgroundColor?: string;
  animate?: boolean;
  /** Prefix for SVG ids (gradients), unique per chart on a page. */
  idPrefix?: string;
  /** Series (and pie slice) colors in order, for series without their own; defaults to the
   * chart palette from `--chart-1`. */
  palette?: readonly string[];
}

export interface PreparedChart {
  /** The Recharts element (or the KPI card block); size it with `width` / `height`. */
  chart: React.ReactElement<{ width?: number; height?: number }>;
  isKpi: boolean;
  legend: LegendEntry[];
  legendLayout: LegendLayout;
  /** The plot width once a right-hand legend column is reserved. */
  chartWidth: number;
  /** An x value read on its own (the tooltip's heading): a date in full, a category labelized. */
  formatLabel: (value: unknown) => string;
}

/** Exact column name in the rows for `key`, matched case-insensitively. */
export function resolveDataKey(data: ChartRow[], key: string | undefined): string {
  if (key === undefined) return "";
  const row = data[0];
  if (!row) return key;
  const lower = key.toLowerCase();
  return Object.keys(row).find((column) => column.toLowerCase() === lower) ?? key;
}

const CHAR_WIDTH_PX = 7;
/** Average width of a tick character (12px system font), for shortening category names. */
const TICK_CHAR_WIDTH_PX = 6;
/** Space kept between two shortened category names. */
const CATEGORY_GAP_PX = 8;
const TICK_PADDING_PX = 12;
const MIN_TICK_WIDTH_PX = 32;
/** Up to this many bars show their values by default. */
const FEW_BARS = 8;
/** The value axes and margins the x ticks cannot use. */
const Y_AXES_ALLOWANCE_PX = 56;

/**
 * How many x ticks fit side by side: the plot's width (less the value axis) over the widest
 * label. At least two, so a narrow chart still shows its first and last value.
 */
export function maxXAxisTicks(plotWidth: number, labelWidth: number): number {
  const usable = Math.max(plotWidth - Y_AXES_ALLOWANCE_PX, 0);
  return Math.max(2, Math.floor(usable / Math.max(labelWidth, MIN_TICK_WIDTH_PX)));
}

/**
 * How many characters each category label may keep so that every category gets its tick, or null
 * when even a short label would not fit (the axis then thins its ticks instead).
 */
export function categoryLabelChars(count: number, plotWidth: number): number | null {
  if (count === 0) return null;
  const slot = Math.max(plotWidth - Y_AXES_ALLOWANCE_PX, 0) / count;
  const chars = Math.floor((slot - CATEGORY_GAP_PX) / TICK_CHAR_WIDTH_PX);
  return chars >= 4 ? chars : null;
}

function truncateLabel(label: string, chars: number): string {
  return label.length > chars ? `${label.slice(0, chars - 1).trimEnd()}…` : label;
}

function estimateMaxLabelWidth(
  data: ChartRow[],
  xAxisKey: string,
  dateFormat?: DateFormatSettings | null,
): number {
  const maxCharCount = data.reduce((max, row) => {
    const formatted = labelize(String(row[xAxisKey] ?? ""), dateFormat);
    return Math.max(max, formatted.length);
  }, 0);
  return Math.max(maxCharCount * CHAR_WIDTH_PX + TICK_PADDING_PX, MIN_TICK_WIDTH_PX);
}

/** The color at `index` of a palette (cycling), or the default chart color without one. */
export function paletteColor(
  palette: readonly string[] | undefined,
  key: string,
  index: number,
): string {
  return palette?.length
    ? (palette[index % palette.length] as string)
    : defaultColorFor(key, index);
}

/** Turns a saved spec and its data into a Recharts element plus the legend a static render needs. */
export function prepareChart(
  spec: ChartSpec,
  rows: ChartRow[],
  options: PrepareChartOptions,
): PreparedChart {
  if (!isBuiltinChartType(spec.chart_type)) {
    throw new Error(`Unknown chart type "${spec.chart_type}".`);
  }
  const chartType = spec.chart_type;
  // Column names are matched case-insensitively against the real rows.
  const xAxisKey = resolveDataKey(rows, spec.x_axis_key ?? undefined);
  const series = spec.series.map((s) => ({ ...s, data_key: resolveDataKey(rows, s.data_key) }));
  const colorFor = (key: string, index: number) =>
    series.find((s) => s.data_key === key)?.color || paletteColor(options.palette, key, index);

  const isPie = chartType === "pie" || chartType === "donut";
  const xValues = rows.map((row) => row[xAxisKey]);
  // Dates sent as a category axis ("2026-01", "2026-02") still read as dates.
  const isDate =
    spec.x_axis_type === "date" ||
    (spec.x_axis_type !== "number" &&
      xValues.length > 0 &&
      xValues.every((value) => isIsoDateLike(value)));
  const dateFormat = isDate ? dateFormatForValues(xValues, options.dateFormat) : options.dateFormat;
  const fullDateFormat = isDate
    ? fullDateFormatForValues(xValues, options.dateFormat)
    : options.dateFormat;
  const ordered = spec.x_axis_type === "date" ? sortByDateKey(rows, xAxisKey) : rows;
  const chartData = isPie ? bucketPieData(ordered, xAxisKey, series[0]?.data_key ?? "") : ordered;

  const legend: LegendEntry[] = isPie
    ? chartData.map((row, i) => {
        const category = String(row[xAxisKey]);
        return { label: labelize(category, dateFormat), color: defaultColorFor(category, i) };
      })
    : series.map((s, i) => ({
        label: s.label || labelize(s.data_key, dateFormat),
        color: colorFor(s.data_key, i),
      }));

  const legendLayout: LegendLayout = isPie && legend.length > 0 ? "vertical" : "horizontal";
  const chartWidth =
    legendLayout === "vertical"
      ? Math.max(options.width - VERTICAL_LEGEND_WIDTH, 0)
      : options.width;

  const labelWidth = estimateMaxLabelWidth(chartData, xAxisKey, dateFormat);
  let xTicks = maxXAxisTicks(chartWidth, labelWidth);
  let tickLabel = (value: string) => labelize(value, dateFormat);
  // Named categories (regions, products) each keep a tick, shortened, rather than every other one
  // disappearing; dates and numbers thin out instead, since the reader can fill in the gaps.
  const vertical = chartType !== "horizontal_bar" && chartType !== "horizontal_bar_100";
  if (!isDate && !isPie && vertical && spec.x_axis_type !== "number" && chartData.length > xTicks) {
    const chars = categoryLabelChars(chartData.length, chartWidth);
    if (chars !== null) {
      xTicks = chartData.length;
      tickLabel = (value: string) => truncateLabel(labelize(value, dateFormat), chars);
    }
  }

  const chart = buildChart({
    data: chartData,
    chartType,
    xAxisKey,
    xAxisType: spec.x_axis_type === "number" ? "number" : "category",
    xAxisLabel: spec.x_axis_label,
    series,
    colorFor,
    labelFormatter: tickLabel,
    showGrid: true,
    // A few bars of one series read best with their values on them, unless the spec says otherwise.
    showDataLabels:
      spec.show_data_labels ??
      (chartType === "bar" && series.length === 1 && chartData.length <= FEW_BARS),
    margin: options.margin ?? { top: 10, right: 20, bottom: 5, left: 0 },
    title: spec.title,
    renderTitle: options.renderTitle,
    maxXAxisTicks: xTicks,
    backgroundColor: options.backgroundColor,
    yAxisMin: spec.y_axis_min,
    yAxisMax: spec.y_axis_max,
    yAxisLabel: spec.y_axis_label,
    yAxisRightMin: spec.y_axis_right_min,
    yAxisRightMax: spec.y_axis_right_max,
    yAxisRightLabel: spec.y_axis_right_label,
    comparisonMode: spec.comparison_mode,
    children: options.children,
    animate: options.animate,
    idPrefix: options.idPrefix,
    gradientIdPrefix: options.idPrefix,
  });
  return {
    chart: chart as PreparedChart["chart"],
    isKpi: chartType === "kpi_card",
    legend,
    legendLayout,
    chartWidth,
    formatLabel: (value: unknown) => labelize(value, fullDateFormat),
  };
}
