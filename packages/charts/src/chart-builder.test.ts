import { Children, isValidElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";

import {
  bucketPieData,
  computeKpiComparison,
  DEFAULT_COLORS,
  defaultColorFor,
  describePreviousPeriod,
  formatPercentShare,
  percentStackSeries,
  sortByDateKey,
} from "./chart-builder.js";
import { ChartDocumentSchema, parseChartDocument } from "./document.js";
import { CHART_FIXTURES } from "./fixtures.js";
import { prepareChart, resolveDataKey } from "./prepare.js";
import { InputSchema } from "./spec.js";

const rows = (values: number[]) =>
  values.map((v, i) => ({ month: `2026-0${i + 1}-01`, revenue: v }));

describe("computeKpiComparison", () => {
  it("compares the latest value to the previous period", () => {
    const result = computeKpiComparison(rows([100, 125]), "month", "revenue", "percentage");
    expect(result).toMatchObject({ valueText: "25%", direction: "up", colored: true });
    expect(result?.periodLabel).toBe("last month");
  });

  it("handles a drop, absolute mode and a zero base", () => {
    expect(computeKpiComparison(rows([200, 150]), "month", "revenue", "variation")).toMatchObject({
      direction: "down",
      colored: true,
    });
    expect(computeKpiComparison(rows([200, 150]), "month", "revenue", "absolute")?.colored).toBe(
      false,
    );
    expect(computeKpiComparison(rows([0, 150]), "month", "revenue", "percentage")).toBeNull();
  });

  it("needs two rows and a mode", () => {
    expect(computeKpiComparison(rows([1]), "month", "revenue", "percentage")).toBeNull();
    expect(computeKpiComparison(rows([1, 2]), "month", "revenue", "none")).toBeNull();
    expect(computeKpiComparison(rows([1, 2]), "month", "revenue", undefined)).toBeNull();
  });

  it("labels the gap between periods", () => {
    expect(describePreviousPeriod("2026-01-01", "2026-01-02")).toBe("yesterday");
    expect(describePreviousPeriod("2026-01-01", "2026-01-08")).toBe("last week");
    expect(describePreviousPeriod("2025-01-01", "2026-01-01")).toBe("last year");
    expect(describePreviousPeriod("x", "y")).toBe("previous period");
  });
});

describe("bucketPieData", () => {
  it("keeps the largest slices and folds the rest into Other", () => {
    const data = Array.from({ length: 12 }, (_, i) => ({ k: `c${i}`, v: i + 1 }));
    const bucketed = bucketPieData(data, "k", "v");
    expect(bucketed.length).toBeLessThan(data.length);
    expect(bucketed.map((r) => r.k)).toContain("Other");
    const total = (list: Record<string, unknown>[]) =>
      list.reduce((sum, r) => sum + Number(r.v), 0);
    expect(total(bucketed)).toBe(total(data));
  });

  it("leaves a short list alone", () => {
    const data = [
      { k: "a", v: 3 },
      { k: "b", v: 1 },
    ];
    expect(bucketPieData(data, "k", "v")).toHaveLength(2);
  });
});

describe("helpers", () => {
  it("sorts by date key without mutating", () => {
    const data = [{ d: "2026-03-01" }, { d: "2026-01-01" }, { d: "2026-02-01" }];
    expect(sortByDateKey(data, "d").map((r) => r.d)).toEqual([
      "2026-01-01",
      "2026-02-01",
      "2026-03-01",
    ]);
    expect(data[0]?.d).toBe("2026-03-01");
  });

  it("drops total series from a 100% stack", () => {
    const series = [{ data_key: "a" }, { data_key: "t", is_total: true }];
    expect(percentStackSeries(series).map((s) => s.data_key)).toEqual(["a"]);
  });

  it("formats shares", () => {
    expect(formatPercentShare(25, 100)).toBe("25%");
    expect(formatPercentShare(1, 3)).toBe("33.3%");
    expect(formatPercentShare(1, 0)).toBe("0%");
  });

  it("colors series from the Nova chart tokens, never hex", () => {
    expect(DEFAULT_COLORS).toHaveLength(8);
    for (const color of DEFAULT_COLORS) expect(color).toMatch(/^var\(--chart-[1-8]\)$/);
    expect(defaultColorFor("x", 9)).toBe("var(--chart-2)");
  });

  it("matches column names case-insensitively", () => {
    expect(resolveDataKey([{ Revenue: 1 }], "revenue")).toBe("Revenue");
    expect(resolveDataKey([], "revenue")).toBe("revenue");
  });
});

describe("prepareChart", () => {
  it.each(CHART_FIXTURES)("builds the $label fixture", (fixture) => {
    const prepared = prepareChart(fixture.spec, fixture.data, { width: 600, height: 360 });
    expect(prepared.chart).toBeTruthy();
    expect(prepared.isKpi).toBe(fixture.spec.chart_type === "kpi_card");
    if (fixture.spec.chart_type === "pie" || fixture.spec.chart_type === "donut") {
      expect(prepared.legendLayout).toBe("vertical");
      expect(prepared.chartWidth).toBe(400);
      expect(prepared.legend).toHaveLength(5);
    } else if (!prepared.isKpi) {
      expect(prepared.legend).toHaveLength(fixture.spec.series.length);
    }
  });

  it("draws the radar ticks after the polygons", () => {
    const fixture = CHART_FIXTURES.find((f) => f.spec.chart_type === "radar");
    if (!fixture) throw new Error("no radar fixture");
    const prepared = prepareChart(fixture.spec, fixture.data, { width: 600, height: 360 });
    const names = Children.toArray((prepared.chart.props as { children?: ReactNode }).children).map(
      (child) => {
        const type = isValidElement(child) ? child.type : null;
        return typeof type === "function" || typeof type === "object"
          ? ((type as { displayName?: string }).displayName ?? "")
          : "";
      },
    );
    const lastRadar = names.lastIndexOf("Radar");
    expect(lastRadar).toBeGreaterThan(-1);
    expect(names.indexOf("PolarRadiusAxis")).toBeGreaterThan(lastRadar);
  });

  it("rejects an unknown chart type", () => {
    const [fixture] = CHART_FIXTURES;
    if (!fixture) throw new Error("no fixtures");
    expect(() =>
      prepareChart({ ...fixture.spec, chart_type: "treemap" as never }, fixture.data, {
        width: 100,
        height: 100,
      }),
    ).toThrow(/Unknown chart type/);
  });
});

describe("spec", () => {
  const source = { path: "r.csv" };
  const base = {
    chart_type: "bar",
    title: "T",
    x_axis_key: "a",
    x_axis_type: "category",
    series: [{ data_key: "b" }],
    source,
  };

  it("accepts a valid call and a kpi card without an x axis", () => {
    expect(InputSchema.safeParse(base).success).toBe(true);
    const { x_axis_key: _k, x_axis_type: _t, ...kpi } = base;
    expect(InputSchema.safeParse({ ...kpi, chart_type: "kpi_card" }).success).toBe(true);
    expect(InputSchema.safeParse({ ...kpi, chart_type: "bar" }).success).toBe(false);
  });

  it("rejects bad axis bounds, an empty series and the retired query_id call", () => {
    expect(InputSchema.safeParse({ ...base, y_axis_min: 5, y_axis_max: 1 }).success).toBe(false);
    expect(InputSchema.safeParse({ ...base, series: [] }).success).toBe(false);
    const { source: _s, ...noSource } = base;
    expect(InputSchema.safeParse({ ...noSource, query_id: "q1" }).success).toBe(false);
  });
});

describe("chart document", () => {
  const doc = {
    version: 1,
    spec: {
      chart_type: "bar",
      title: "T",
      series: [{ data_key: "b" }],
      x_axis_key: "a",
      x_axis_type: "category",
    },
    source: { file: "r.csv", path: "r.csv", columns: ["a", "b"], rows: 1, truncated: false },
    data: [{ a: "x", b: 1 }],
  };

  it("parses what the engine writes and nothing else", () => {
    expect(ChartDocumentSchema.safeParse(doc).success).toBe(true);
    const bytes = new TextEncoder().encode(JSON.stringify(doc));
    expect(parseChartDocument(bytes)?.data).toHaveLength(1);
    expect(parseChartDocument(new TextEncoder().encode("{}"))).toBeNull();
    expect(parseChartDocument(new TextEncoder().encode("not json"))).toBeNull();
  });
});
