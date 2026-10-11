// @vitest-environment jsdom

import { call } from "@orpc/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chartsRouter } from "./charts";

const doc = {
  version: 1,
  spec: {
    chart_type: "bar",
    title: "T",
    x_axis_key: "k",
    x_axis_type: "category",
    series: [{ data_key: "v" }],
  },
  source: { file: "r.csv", path: "r.csv", columns: ["k", "v"], rows: 1, truncated: false },
  data: [{ k: "a", v: 1 }],
};

/** The engine holding one artifact: `meta` is its row, `body` its content. */
function engine(meta: { name: string; version: number }, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL | string) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/content")) return new Response(JSON.stringify(body));
      return new Response(JSON.stringify({ ...meta, all_versions: [] }), {
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

const thumbnail = (artifactId: string) =>
  call(chartsRouter.charts.thumbnail, {
    artifactId,
    theme: "light",
    width: 640,
    height: 400,
  });

const svgOf = (contentBase64: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(contentBase64), (c) => c.charCodeAt(0)));

afterEach(() => vi.unstubAllGlobals());

describe("charts.thumbnail", () => {
  it("draws a chart as a self-contained SVG with its size", async () => {
    engine({ name: "t.chart.json", version: 1 }, doc);
    const image = await thumbnail("a1");
    expect(image).toMatchObject({ mimeType: "image/svg+xml", width: 640, height: 424 });
    expect(svgOf(image.contentBase64).startsWith("<svg")).toBe(true);
  });

  it("refuses a file that is not a chart or is unreadable", async () => {
    engine({ name: "x.pdf", version: 1 }, doc);
    await expect(thumbnail("n1")).rejects.toMatchObject({ code: "BAD_REQUEST" });
    engine({ name: "t.chart.json", version: 1 }, {});
    await expect(thumbnail("n2")).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("draws a dashboard as its first chart", async () => {
    const first = { ...doc, spec: { ...doc.spec, title: "First" } };
    engine(
      { name: "d.dashboard.json", version: 1 },
      { version: 1, title: "D", kpis: [], charts: [first, doc] },
    );
    expect(svgOf((await thumbnail("dash")).contentBase64)).toContain("First");
  });
});
