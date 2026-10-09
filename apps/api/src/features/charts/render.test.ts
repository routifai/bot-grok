import { CHART_FIXTURES } from "@nova/charts";
import { describe, expect, it } from "vitest";
import { renderChart, renderChartSvg, resolveTokens, truncateLabel } from "./render.js";

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

describe("renderChartSvg", () => {
  it.each(CHART_FIXTURES)("draws the $label fixture as a self-contained SVG", (fixture) => {
    for (const theme of ["light", "dark"] as const) {
      const svg = renderChartSvg(fixture, { width: 640, height: 400, theme });
      expect(svg.startsWith("<svg")).toBe(true);
      expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
      // no CSS variable survives: an image tag cannot read the page's theme
      expect(svg).not.toMatch(/="[^"]*var\(--/);
      expect(svg).toContain(fixture.spec.title.split(" ")[0] ?? "");
    }
  });

  it("paints with the theme's tokens", () => {
    const [bar] = CHART_FIXTURES;
    if (!bar) throw new Error("no fixtures");
    const light = renderChartSvg(bar, { width: 640, height: 400, theme: "light" });
    const dark = renderChartSvg(bar, { width: 640, height: 400, theme: "dark" });
    expect(light.toLowerCase()).toContain('<rect width="640" height="424" fill="#ffffff"/>');
    expect(dark.toLowerCase()).not.toContain('fill="#ffffff"');
    expect(light).not.toEqual(dark);
  });

  it("draws the KPI number and its comparison", () => {
    const kpi = CHART_FIXTURES.find((f) => f.id === "kpi");
    if (!kpi) throw new Error("no kpi fixture");
    const svg = renderChartSvg(kpi, { width: 400, height: 240, theme: "light" });
    expect(svg).toContain("$190,300");
    expect(svg).toMatch(/▲ 8\.8% vs\. last month/);
  });

  it("escapes data text", () => {
    const svg = renderChartSvg(
      {
        spec: {
          chart_type: "bar",
          title: "A <b> & C",
          x_axis_key: "k",
          x_axis_type: "category",
          series: [{ data_key: "v", label: "x</text><script>" }],
        },
        data: [{ k: "a", v: 1 }],
      },
      { width: 400, height: 300, theme: "light" },
    );
    expect(svg).not.toContain("<script>");
  });
});

describe("untrusted colors", () => {
  it("cannot break out of an SVG attribute", () => {
    const evil = 'red" onload="alert(1)';
    const svg = renderChartSvg(
      {
        spec: {
          chart_type: "bar",
          title: "T",
          x_axis_key: "k",
          x_axis_type: "category",
          series: [{ data_key: "v", color: evil }],
        },
        data: [{ k: "a", v: 1 }],
      },
      { width: 400, height: 300, theme: "light" },
    );
    // The quote is escaped, so "onload=" stays inside the fill value and is never an attribute.
    expect(svg).not.toContain('" onload="');
    expect(svg).toContain("&quot; onload=&quot;");
  });
});

describe("renderChart", () => {
  it("rasterises to a PNG, 2x", () => {
    const [bar] = CHART_FIXTURES;
    if (!bar) throw new Error("no fixtures");
    const image = renderChart(bar, { width: 640, height: 400, theme: "light", format: "png" });
    expect(image.mimeType).toBe("image/png");
    expect([...image.bytes.subarray(0, 4)]).toEqual(PNG_MAGIC);
    const wide = image.bytes.readUInt32BE(16);
    expect(wide).toBe(image.width * 2);
    expect(image.bytes.length).toBeGreaterThan(2000);
  });

  it("returns the SVG text on request", () => {
    const [bar] = CHART_FIXTURES;
    if (!bar) throw new Error("no fixtures");
    const image = renderChart(bar, { width: 640, height: 400, theme: "dark", format: "svg" });
    expect(image.mimeType).toBe("image/svg+xml");
    expect(image.bytes.toString("utf8").startsWith("<svg")).toBe(true);
  });

  it("rasterises every chart type", () => {
    for (const fixture of CHART_FIXTURES) {
      const image = renderChart(fixture, {
        width: 480,
        height: 300,
        theme: "light",
        format: "png",
      });
      expect([...image.bytes.subarray(0, 4)]).toEqual(PNG_MAGIC);
    }
  });
});

describe("helpers", () => {
  it("resolves tokens only inside attributes", () => {
    const svg = '<g fill="var(--background)"><text>var(--foreground)</text></g>';
    const out = resolveTokens(svg, "light");
    expect(out).not.toContain('fill="var(');
    expect(out).toContain("<text>var(--foreground)</text>");
  });

  it("truncates on code points", () => {
    expect(truncateLabel("abcdef", 4)).toBe("abc…");
    expect(truncateLabel("ab", 4)).toBe("ab");
    expect(truncateLabel("😀😀😀😀", 3)).toBe("😀😀…");
  });
});
