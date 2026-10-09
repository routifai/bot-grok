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
import type { DateFormatSettings } from "./date.js";
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
}

export interface PreparedChart {
  /** The Recharts element (or the KPI card block); size it with `width` / `height`. */
  chart: React.ReactElement<{ width?: number; height?: number }>;
  isKpi: boolean;
  legend: LegendEntry[];
  legendLayout: LegendLayout;
  /** The plot width once a right-hand legend column is reserved. */
  chartWidth: number;
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
const TICK_PADDING_PX = 16;
const MIN_TICK_WIDTH_PX = 40;

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
  const { dateFormat } = options;
  // Column names are matched case-insensitively against the real rows.
  const xAxisKey = resolveDataKey(rows, spec.x_axis_key ?? undefined);
  const series = spec.series.map((s) => ({ ...s, data_key: resolveDataKey(rows, s.data_key) }));
  const colorFor = (key: string, index: number) =>
    series.find((s) => s.data_key === key)?.color || defaultColorFor(key, index);

  const isPie = chartType === "pie" || chartType === "donut";
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

  const chart = buildChart({
    data: chartData,
    chartType,
    xAxisKey,
    xAxisType: spec.x_axis_type === "number" ? "number" : "category",
    xAxisLabel: spec.x_axis_label,
    series,
    colorFor,
    labelFormatter: (value: string) => labelize(value, dateFormat),
    showGrid: true,
    showDataLabels: spec.show_data_labels,
    margin: options.margin ?? { top: 10, right: 20, bottom: 5, left: 0 },
    title: spec.title,
    renderTitle: options.renderTitle,
    maxXAxisTicks: Math.floor(chartWidth / estimateMaxLabelWidth(chartData, xAxisKey, dateFormat)),
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
  });
  return {
    chart: chart as PreparedChart["chart"],
    isKpi: chartType === "kpi_card",
    legend,
    legendLayout,
    chartWidth,
  };
}
