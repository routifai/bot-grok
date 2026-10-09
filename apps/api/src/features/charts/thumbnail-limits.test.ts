import type { ChartDocument } from "@nova/charts";
import { describe, expect, it } from "vitest";
import {
  limitForThumbnail,
  THUMBNAIL_MAX_POINTS,
  THUMBNAIL_MAX_SERIES,
} from "./thumbnail-limits.js";

const doc = (
  rows: number,
  series: number,
  type = "line",
): Pick<ChartDocument, "spec" | "data"> => ({
  spec: {
    chart_type: type as never,
    title: "T",
    x_axis_key: "x",
    x_axis_type: "number",
    series: Array.from({ length: series }, (_, i) => ({ data_key: `s${i}` })),
  },
  data: Array.from({ length: rows }, (_, i) => ({ x: i, s0: i })),
});

describe("limitForThumbnail", () => {
  it("leaves a small chart alone", () => {
    const small = doc(40, 3);
    expect(limitForThumbnail(small)).toEqual(small);
  });

  it("samples a long series down, keeping the first and last rows", () => {
    const out = limitForThumbnail(doc(5000, 2));
    expect(out.data).toHaveLength(THUMBNAIL_MAX_POINTS);
    expect(out.data[0]?.x).toBe(0);
    expect(out.data.at(-1)?.x).toBe(4999);
    const xs = out.data.map((row) => Number(row.x));
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
  });

  it("caps the series", () => {
    expect(limitForThumbnail(doc(10, 50)).spec.series).toHaveLength(THUMBNAIL_MAX_SERIES);
  });

  it("keeps the two rows a KPI comparison reads", () => {
    const out = limitForThumbnail(doc(5000, 1, "kpi_card"));
    expect(out.data.map((row) => row.x)).toEqual([4998, 4999]);
  });
});
