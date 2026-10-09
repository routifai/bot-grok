import type { Actor } from "@nova/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RenderBusyError } from "./pool.js";

const adapters = vi.hoisted(() => ({ meta: vi.fn(), content: vi.fn() }));
vi.mock("@nova/adapters", () => ({
  getOmnigentArtifact: adapters.meta,
  fetchOmnigentArtifactContent: adapters.content,
}));
vi.mock("../artifacts/index.js", () => ({
  emailOf: async () => "a@example.com",
  notFound: (error: unknown) => {
    throw error;
  },
}));

import { engineChartThumbnail } from "./service.js";

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
const bytes = new TextEncoder().encode(JSON.stringify(doc));
const deps = {} as never;
const client = {} as never;
const actor = {} as Actor;
const input = (artifactId: string) => ({
  artifactId,
  format: "png" as const,
  theme: "light" as const,
  width: 640,
  height: 400,
});
const image = {
  mimeType: "image/png" as const,
  bytes: Buffer.from([1, 2, 3]),
  width: 640,
  height: 400,
};

beforeEach(() => {
  adapters.meta.mockReset().mockResolvedValue({ name: "t.chart.json", version: 1 });
  adapters.content.mockReset().mockResolvedValue(bytes);
});

describe("engineChartThumbnail", () => {
  it("draws once per (artifact, version, theme, size) and then serves the cache", async () => {
    const render = vi.fn().mockResolvedValue(image);
    const first = await engineChartThumbnail(deps, client, actor, input("cache-a"), render);
    const second = await engineChartThumbnail(deps, client, actor, input("cache-a"), render);
    expect(first).toEqual({
      mimeType: "image/png",
      contentBase64: "AQID",
      width: 640,
      height: 400,
    });
    expect(second).toEqual(first);
    expect(render).toHaveBeenCalledTimes(1);
    expect(adapters.content).toHaveBeenCalledTimes(1);

    adapters.meta.mockResolvedValue({ name: "t.chart.json", version: 2 }); // a new version redraws
    await engineChartThumbnail(deps, client, actor, input("cache-a"), render);
    await engineChartThumbnail(deps, client, actor, { ...input("cache-a"), theme: "dark" }, render);
    expect(render).toHaveBeenCalledTimes(3);
  });

  it("still checks access before serving a cached image", async () => {
    const render = vi.fn().mockResolvedValue(image);
    await engineChartThumbnail(deps, client, actor, input("cache-b"), render);
    adapters.meta.mockRejectedValueOnce(new Error("forbidden"));
    await expect(
      engineChartThumbnail(deps, client, actor, input("cache-b"), render),
    ).rejects.toThrow("forbidden");
  });

  it("refuses a file that is not a chart or is unreadable", async () => {
    const render = vi.fn();
    adapters.meta.mockResolvedValue({ name: "x.pdf", version: 1 });
    await expect(
      engineChartThumbnail(deps, client, actor, input("n1"), render),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    adapters.meta.mockResolvedValue({ name: "t.chart.json", version: 1 });
    adapters.content.mockResolvedValue(new TextEncoder().encode("{}"));
    await expect(
      engineChartThumbnail(deps, client, actor, input("n2"), render),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(render).not.toHaveBeenCalled();
  });

  it("draws a dashboard as its first chart", async () => {
    const first = { ...doc, spec: { ...doc.spec, title: "First" } };
    const dashboard = { version: 1, title: "D", kpis: [], charts: [first, doc] };
    adapters.meta.mockResolvedValue({ name: "d.dashboard.json", version: 1 });
    adapters.content.mockResolvedValue(new TextEncoder().encode(JSON.stringify(dashboard)));
    const render = vi.fn().mockResolvedValue(image);
    await engineChartThumbnail(deps, client, actor, input("dash"), render);
    expect(render.mock.calls[0]?.[0].document.spec.title).toBe("First");
  });

  it("hands the renderer a thumbnail-sized document", async () => {
    const big = { ...doc, data: Array.from({ length: 5000 }, (_, i) => ({ k: String(i), v: i })) };
    adapters.content.mockResolvedValue(new TextEncoder().encode(JSON.stringify(big)));
    const render = vi.fn().mockResolvedValue(image);
    await engineChartThumbnail(deps, client, actor, input("big"), render);
    expect(render.mock.calls[0]?.[0].document.data).toHaveLength(500);
  });

  it("maps a full queue to SERVICE_UNAVAILABLE and other failures to INTERNAL_SERVER_ERROR", async () => {
    await expect(
      engineChartThumbnail(deps, client, actor, input("busy"), async () => {
        throw new RenderBusyError("busy");
      }),
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    await expect(
      engineChartThumbnail(deps, client, actor, input("fail"), async () => {
        throw new Error("boom");
      }),
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
  });
});
