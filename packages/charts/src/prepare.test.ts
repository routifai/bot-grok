import { describe, expect, it } from "vitest";
import { formatValueYAxisTick } from "./chart-builder.js";
import { evenTicks } from "./chart-domain.js";
import { categoryLabelChars, maxXAxisTicks, prepareChart } from "./prepare.js";

describe("x axis ticks", () => {
  it("fits as many labels as the plot's width holds", () => {
    // 640px wide, 56px for the value axis, 40px labels: 14 ticks.
    expect(maxXAxisTicks(640, 40)).toBe(14);
    // A narrow card thins long date labels instead of overlapping them.
    expect(maxXAxisTicks(300, 100)).toBe(2);
    expect(maxXAxisTicks(520, 100)).toBe(4);
  });

  it("keeps the first and last tick however narrow the plot", () => {
    expect(maxXAxisTicks(0, 80)).toBe(2);
  });
});

describe("category labels", () => {
  it("shortens names so every category keeps its tick", () => {
    // 5 regions in a 340px plot: 56px per slot, 8 characters each.
    expect(categoryLabelChars(5, 340)).toBe(8);
    expect(categoryLabelChars(4, 640)).toBe(23);
  });

  it("gives up when even a short name would not fit", () => {
    expect(categoryLabelChars(40, 400)).toBeNull();
    expect(categoryLabelChars(0, 400)).toBeNull();
  });
});

describe("value axis", () => {
  it("keeps neighbouring ticks apart when the series uses a short SI format", () => {
    const money = { d3_format: ",.2s", prefix: "$" };
    expect(formatValueYAxisTick(1_350_000, money)).toBe("$1.35M");
    expect(formatValueYAxisTick(1_300_000, money)).toBe("$1.3M");
    expect(formatValueYAxisTick(27.5, { d3_format: ".1f", suffix: "%" })).toBe("27.5%");
  });
});

describe("dates on a category axis", () => {
  it("still reads them as months", () => {
    const rows = ["2026-01", "2026-02", "2026-03"].map((month, i) => ({ month, revenue: i }));
    const prepared = prepareChart(
      {
        chart_type: "line",
        title: "Revenue",
        x_axis_key: "month",
        x_axis_type: "category",
        series: [{ data_key: "revenue" }],
      },
      rows,
      { width: 640, height: 320 },
    );
    expect(prepared.formatLabel("2026-02")).toBe("Feb 2026");
  });
});

describe("value axis ticks", () => {
  it("steps evenly through a fixed domain", () => {
    expect(evenTicks([1_200_000, 1_450_000])).toEqual([
      1_200_000, 1_250_000, 1_300_000, 1_350_000, 1_400_000, 1_450_000,
    ]); // fmt: skip
    expect(evenTicks(["auto", "auto"])).toBeUndefined();
    expect(evenTicks(undefined)).toBeUndefined();
  });
});
