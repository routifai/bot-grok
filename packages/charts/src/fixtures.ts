import type { DashboardDocument } from "./dashboard.js";
import type { ChartDocument } from "./document.js";
import type { ChartRow } from "./prepare.js";
import type { ChartSpec } from "./spec.js";

/** One sample chart: the dev route, the render tests and the builder tests share these. */
export interface ChartFixture {
  id: string;
  label: string;
  spec: ChartSpec;
  data: ChartRow[];
}

const MONTHS = ["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01", "2026-05-01", "2026-06-01"];
const REVENUE = [128_000, 142_500, 139_800, 161_200, 174_900, 190_300];
const COST = [91_000, 98_400, 102_100, 110_800, 118_600, 126_000];
const MARGIN = [28.9, 30.9, 27.0, 31.3, 32.2, 33.8];

const monthly: ChartRow[] = MONTHS.map((month, i) => ({
  month,
  revenue: REVENUE[i],
  cost: COST[i],
  margin_pct: MARGIN[i],
}));

const USD = { d3_format: ",.0f", prefix: "$", compact: "financial" as const };

const regions: ChartRow[] = [
  { region: "North America", sales: 412 },
  { region: "Europe", sales: 318 },
  { region: "Asia Pacific", sales: 267 },
  { region: "Latin America", sales: 96 },
  { region: "Middle East", sales: 54 },
];

const channel: ChartRow[] = [
  { quarter: "Q1", online: 220, retail: 140, partners: 80 },
  { quarter: "Q2", online: 260, retail: 132, partners: 96 },
  { quarter: "Q3", online: 310, retail: 128, partners: 110 },
  { quarter: "Q4", online: 372, retail: 150, partners: 124 },
];

const SCATTER: ChartRow[] = [
  { spend: 12, signups: 40 },
  { spend: 18, signups: 52 },
  { spend: 25, signups: 71 },
  { spend: 31, signups: 80 },
  { spend: 40, signups: 118 },
  { spend: 47, signups: 121 },
  { spend: 55, signups: 160 },
];

const RADAR: ChartRow[] = [
  { skill: "Speed", team_a: 82, team_b: 64 },
  { skill: "Quality", team_a: 71, team_b: 88 },
  { skill: "Cost", team_a: 60, team_b: 75 },
  { skill: "Support", team_a: 90, team_b: 70 },
  { skill: "Reach", team_a: 55, team_b: 81 },
];

const CHANNEL_SERIES = [
  { data_key: "online", label: "Online" },
  { data_key: "retail", label: "Retail" },
  { data_key: "partners", label: "Partners" },
];

export const CHART_FIXTURES: ChartFixture[] = [
  {
    id: "bar",
    label: "Bar",
    spec: {
      chart_type: "bar",
      title: "Sales by region",
      x_axis_key: "region",
      x_axis_type: "category",
      series: [{ data_key: "sales", label: "Sales", value_format: { prefix: "$", suffix: "k" } }],
      show_data_labels: true,
    },
    data: regions,
  },
  {
    id: "stacked",
    label: "Stacked bar",
    spec: {
      chart_type: "stacked_bar",
      title: "Orders by channel",
      x_axis_key: "quarter",
      x_axis_type: "category",
      series: [
        { data_key: "online", label: "Online" },
        { data_key: "retail", label: "Retail" },
        { data_key: "partners", label: "Partners" },
      ],
    },
    data: channel,
  },
  {
    id: "line",
    label: "Line",
    spec: {
      chart_type: "line",
      title: "Revenue and cost",
      x_axis_key: "month",
      x_axis_type: "date",
      x_axis_label: "Month",
      series: [
        { data_key: "revenue", label: "Revenue", value_format: USD },
        { data_key: "cost", label: "Cost", value_format: USD },
      ],
    },
    data: monthly,
  },
  {
    id: "area",
    label: "Area",
    spec: {
      chart_type: "area",
      title: "Revenue",
      x_axis_key: "month",
      x_axis_type: "date",
      series: [{ data_key: "revenue", label: "Revenue", value_format: USD }],
    },
    data: monthly,
  },
  {
    id: "mixed",
    label: "Mixed",
    spec: {
      chart_type: "mixed",
      title: "Revenue and cost",
      x_axis_key: "month",
      x_axis_type: "date",
      series: [
        { data_key: "revenue", label: "Revenue", series_type: "bar", value_format: USD },
        { data_key: "cost", label: "Cost", series_type: "line", value_format: USD },
      ],
    },
    data: monthly,
  },
  {
    id: "dual-axis",
    label: "Dual axis",
    spec: {
      chart_type: "mixed",
      title: "Revenue and margin",
      x_axis_key: "month",
      x_axis_type: "date",
      y_axis_label: "Revenue",
      y_axis_right_label: "Margin",
      hide_total: true,
      series: [
        { data_key: "revenue", label: "Revenue", series_type: "bar", value_format: USD },
        {
          data_key: "margin_pct",
          label: "Margin",
          series_type: "line",
          y_axis: "right",
          value_format: { d3_format: ".1f", suffix: "%" },
        },
      ],
    },
    data: monthly,
  },
  {
    id: "pie",
    label: "Pie",
    spec: {
      chart_type: "pie",
      title: "Share of sales by region",
      x_axis_key: "region",
      x_axis_type: "category",
      series: [{ data_key: "sales", label: "Sales" }],
    },
    data: regions,
  },
  {
    id: "kpi",
    label: "KPI with comparison",
    spec: {
      chart_type: "kpi_card",
      title: "Monthly revenue",
      x_axis_key: "month",
      x_axis_type: "date",
      comparison_mode: "percentage",
      series: [{ data_key: "revenue", label: "Revenue", value_format: USD }],
    },
    data: monthly,
  },
  {
    id: "horizontal-bar",
    label: "Horizontal bar",
    spec: {
      chart_type: "horizontal_bar",
      title: "Sales by region (ranked)",
      x_axis_key: "region",
      x_axis_type: "category",
      series: [{ data_key: "sales", label: "Sales" }],
    },
    data: regions,
  },
  {
    id: "horizontal-bar-100",
    label: "Horizontal bar 100%",
    spec: {
      chart_type: "horizontal_bar_100",
      title: "Channel mix per quarter",
      x_axis_key: "quarter",
      x_axis_type: "category",
      series: CHANNEL_SERIES,
    },
    data: channel,
  },
  {
    id: "stacked-bar-100",
    label: "Stacked bar 100%",
    spec: {
      chart_type: "stacked_bar_100",
      title: "Channel share of orders",
      x_axis_key: "quarter",
      x_axis_type: "category",
      series: CHANNEL_SERIES,
    },
    data: channel,
  },
  {
    id: "stacked-area",
    label: "Stacked area",
    spec: {
      chart_type: "stacked_area",
      title: "Orders by channel over time",
      x_axis_key: "quarter",
      x_axis_type: "category",
      series: CHANNEL_SERIES,
    },
    data: channel,
  },
  {
    id: "stacked-area-100",
    label: "Stacked area 100%",
    spec: {
      chart_type: "stacked_area_100",
      title: "Channel share over time",
      x_axis_key: "quarter",
      x_axis_type: "category",
      series: CHANNEL_SERIES,
    },
    data: channel,
  },
  {
    id: "donut",
    label: "Donut",
    spec: {
      chart_type: "donut",
      title: "Sales by region",
      x_axis_key: "region",
      x_axis_type: "category",
      series: [{ data_key: "sales", label: "Sales" }],
    },
    data: regions,
  },
  {
    id: "scatter",
    label: "Scatter",
    spec: {
      chart_type: "scatter",
      title: "Signups against ad spend",
      x_axis_key: "spend",
      x_axis_type: "number",
      x_axis_label: "Spend ($k)",
      y_axis_label: "Signups",
      series: [{ data_key: "signups", label: "Signups" }],
    },
    data: SCATTER,
  },
  {
    id: "radar",
    label: "Radar",
    spec: {
      chart_type: "radar",
      title: "Team profile",
      x_axis_key: "skill",
      x_axis_type: "category",
      series: [
        { data_key: "team_a", label: "Team A" },
        { data_key: "team_b", label: "Team B" },
      ],
    },
    data: RADAR,
  },
];

const YEAR = [
  "2026-01-01",
  "2026-02-01",
  "2026-03-01",
  "2026-04-01",
  "2026-05-01",
  "2026-06-01",
  "2026-07-01",
  "2026-08-01",
  "2026-09-01",
  "2026-10-01",
  "2026-11-01",
  "2026-12-01",
];
const YEAR_REVENUE = [
  1_209_400, 1_297_100, 1_358_300, 1_386_900, 1_411_000, 1_360_500, 1_351_400, 1_258_800, 1_274_900,
  1_287_700, 1_262_100, 1_396_400,
];
const YEAR_MARGIN = [27.6, 29.4, 26.1, 27.0, 28.1, 24.9, 27.7, 26.1, 25.3, 29.8, 26.5, 28.6];
const year: ChartRow[] = YEAR.map((month, i) => ({
  month,
  revenue: YEAR_REVENUE[i],
  margin_pct: YEAR_MARGIN[i],
}));
const regionTotals: ChartRow[] = [
  { region: "North America", revenue: 6_805_400 },
  { region: "Europe", revenue: 5_016_600 },
  { region: "Asia Pacific", revenue: 4_334_500 },
];
const PCT = { d3_format: ".1f", suffix: "%" };
const USD_SHORT = { d3_format: ".3s", prefix: "$" };

function sampleDocument(file: string, spec: ChartSpec, data: ChartRow[]): ChartDocument {
  return {
    version: 1,
    spec,
    source: {
      file,
      path: `chart_data/${file}`,
      columns: Object.keys(data[0] ?? {}),
      rows: data.length,
      truncated: false,
    },
    data,
  };
}

/** A sample dashboard (the dev route and the dashboard tests): KPI tiles, a wide trend, three. */
export const DASHBOARD_FIXTURE: DashboardDocument = {
  version: 1,
  title: "Sales 2026",
  kpis: [
    sampleDocument(
      "kpi.csv",
      {
        chart_type: "kpi_card",
        title: "Total revenue",
        series: [{ data_key: "revenue", value_format: { d3_format: ",.0f", prefix: "$" } }],
      },
      [{ revenue: 16_156_500 }],
    ),
    sampleDocument(
      "monthly.csv",
      {
        chart_type: "kpi_card",
        title: "December revenue",
        x_axis_key: "month",
        comparison_mode: "percentage",
        series: [{ data_key: "revenue", value_format: { d3_format: ",.3s", prefix: "$" } }],
      },
      year.slice(-2),
    ),
    sampleDocument(
      "kpi.csv",
      {
        chart_type: "kpi_card",
        title: "Average margin",
        series: [{ data_key: "margin_pct", value_format: PCT }],
      },
      [{ margin_pct: 27.3 }],
    ),
  ],
  charts: [
    {
      ...sampleDocument(
        "monthly.csv",
        {
          chart_type: "line",
          title: "Revenue by month",
          x_axis_key: "month",
          x_axis_type: "date",
          series: [{ data_key: "revenue", label: "Revenue", value_format: USD_SHORT }],
        },
        year,
      ),
      wide: true,
    },
    sampleDocument(
      "region.csv",
      {
        chart_type: "bar",
        title: "Revenue by region",
        x_axis_key: "region",
        x_axis_type: "category",
        series: [{ data_key: "revenue", label: "Revenue", value_format: USD_SHORT }],
      },
      regionTotals,
    ),
    sampleDocument(
      "region.csv",
      {
        chart_type: "donut",
        title: "Region share of revenue",
        x_axis_key: "region",
        x_axis_type: "category",
        series: [{ data_key: "revenue", label: "Revenue", value_format: USD_SHORT }],
      },
      regionTotals,
    ),
    {
      ...sampleDocument(
        "monthly.csv",
        {
          chart_type: "mixed",
          title: "Revenue against margin",
          x_axis_key: "month",
          x_axis_type: "date",
          series: [
            { data_key: "revenue", label: "Revenue", value_format: USD_SHORT, series_type: "bar" },
            {
              data_key: "margin_pct",
              label: "Margin",
              value_format: PCT,
              series_type: "line",
              y_axis: "right",
            },
          ],
        },
        year,
      ),
      wide: true,
    },
  ],
};
