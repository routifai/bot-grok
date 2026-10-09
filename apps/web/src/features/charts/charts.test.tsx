// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { CHART_FIXTURES, type ChartDocument } from "@nova/charts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ getById: vi.fn(), thumbnail: vi.fn() }));
vi.mock("../../lib/rpc", () => ({ rpc: { artifacts: api, charts: api } }));
vi.mock("../../lib/artifact-open", () => ({
  decodeArtifactBase64: (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)),
}));

import { ChartInlinePreview } from "./ChartArtifact";
import { ChartGallery, chartOfMessage } from "./ChartResult";
import { ChartThumbnail } from "./ChartThumbnail";
import { ChartView } from "./ChartView";
import { chartsExtension } from "./extension";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  api.getById.mockReset();
  api.thumbnail.mockReset();
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(() => host.remove());

function documentOf(id: string): ChartDocument {
  const fixture = CHART_FIXTURES.find((f) => f.id === id);
  if (!fixture) throw new Error(id);
  return {
    version: 1,
    spec: fixture.spec,
    data: fixture.data,
    source: {
      file: `${id}.csv`,
      path: `${id}.csv`,
      columns: [],
      rows: fixture.data.length,
      truncated: false,
    },
  };
}

i18n.loadAndActivate({ locale: "en", messages: {} });

function render(node: React.ReactNode) {
  const root = createRoot(host);
  act(() => root.render(<I18nProvider i18n={i18n}>{node}</I18nProvider>));
  return root;
}

it("shows a KPI card with its number, comparison and source", () => {
  render(<ChartView document={documentOf("kpi")} />);
  expect(host.textContent).toContain("Monthly revenue");
  expect(host.textContent).toContain("$190,300");
  expect(host.textContent).toContain("8.8%");
  expect(host.textContent).toContain("vs. last month");
  expect(host.textContent).toContain("Source: kpi.csv");
});

it("says which rows a cut chart keeps", () => {
  const doc = documentOf("kpi");
  const cut = (spec: Partial<typeof doc.spec>, source: Partial<typeof doc.source>) =>
    render(
      <ChartView
        document={{
          ...doc,
          spec: { ...doc.spec, ...spec },
          source: { ...doc.source, truncated: true, rows: 6, ...source },
        }}
      />,
    );
  const plain = cut({ x_axis_type: "category" }, {});
  expect(host.textContent).toContain("first 6 rows");
  act(() => plain.unmount());
  const dated = cut({ x_axis_type: "date" }, {});
  expect(host.textContent).toContain("latest 6 rows");
  expect(host.textContent).not.toContain("first 6 rows");
  act(() => dated.unmount());
  cut({ x_axis_type: "date" }, { read_cut: true });
  expect(host.textContent).toContain("only its start was read");
});

it("draws every other chart type inside a responsive frame without throwing", () => {
  for (const fixture of CHART_FIXTURES.filter((f) => f.id !== "kpi")) {
    const root = render(<ChartView document={documentOf(fixture.id)} height={300} />);
    expect(host.querySelector(`[data-chart="${fixture.spec.chart_type}"]`)).not.toBeNull();
    expect(host.textContent).toContain(fixture.spec.title);
    act(() => root.unmount());
  }
});

it("claims only chart files", () => {
  expect(chartsExtension.card({ name: "a.chart.json" } as never)).toEqual({ meta: "Chart" });
  expect(chartsExtension.card({ name: "a.json" } as never)).toBeNull();
  const args = { artifactId: "a", version: 1, near: true };
  expect(chartsExtension.inline?.({ ...args, name: "a.chart.json" })).not.toBeNull();
  expect(chartsExtension.inline?.({ ...args, name: "a.pdf" })).toBeNull();
  expect(
    chartsExtension.thumbnail?.({ id: "a", name: "a.chart.json", mimeType: "x" }),
  ).not.toBeNull();
  expect(chartsExtension.thumbnail?.({ id: "a", name: "a.png", mimeType: "image/png" })).toBeNull();
});

it("loads the inline preview's document once near the viewport", async () => {
  const doc = documentOf("kpi");
  api.getById.mockResolvedValue({ contentBase64: btoa(JSON.stringify(doc)) });
  render(<ChartInlinePreview artifactId="inline-1" version={1} enabled={false} />);
  expect(api.getById).not.toHaveBeenCalled();
  const root = render(<ChartInlinePreview artifactId="inline-1" version={1} enabled />);
  await act(async () => {
    await Promise.resolve();
  });
  expect(api.getById).toHaveBeenCalledWith({ artifactId: "inline-1" });
  expect(host.textContent).toContain("$190,300");
  act(() => root.unmount());
});

it("falls back to the plain file view when the chart file is unreadable", async () => {
  api.getById.mockResolvedValue({ contentBase64: btoa("not a chart") });
  render(<ChartInlinePreview artifactId="inline-2" version={1} enabled />);
  await act(async () => {
    await Promise.resolve();
  });
  expect(host.querySelector('[role="img"]')).not.toBeNull();
});

it("asks the server for the Library thumbnail in the current theme", async () => {
  document.documentElement.dataset.theme = "dark";
  api.thumbnail.mockResolvedValue({
    mimeType: "image/png",
    contentBase64: "AAAA",
    width: 1,
    height: 1,
  });
  const root = render(<ChartThumbnail artifactId="thumb-1" version={2} />);
  await act(async () => {
    await Promise.resolve();
  });
  expect(api.thumbnail).toHaveBeenCalledWith({
    artifactId: "thumb-1",
    format: "png",
    theme: "dark",
    width: 640,
    height: 400,
  });
  expect(host.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
  act(() => root.unmount());
  delete document.documentElement.dataset.theme;
});

function chartMessage(id: string, name = `${id}.chart.json`) {
  return {
    id: `m-${id}`,
    role: "bot",
    createdAt: "2026-10-09T00:00:00Z",
    blocks: [
      {
        kind: "reply_card",
        card: "file",
        id: `artifact:${id}`,
        data: { name, artifactId: id, kind: "json", size: 10, version: 1 },
        fallback: "Saved",
      },
    ],
  } as never;
}

it("reads a chart only from a message that is one chart file card", () => {
  expect(chartOfMessage(chartMessage("a"))).toMatchObject({ artifactId: "a", messageId: "m-a" });
  expect(chartOfMessage(chartMessage("b", "b.json"))).toBeNull();
  expect(
    chartOfMessage({ id: "t", role: "bot", blocks: [{ kind: "text", text: "hi" }] } as never),
  ).toBeNull();
});

it("lays a dashboard reply out as KPI tiles and chart cards, never file cards", async () => {
  const docs: Record<string, ChartDocument> = {
    "g-kpi": documentOf("kpi"),
    "g-line": documentOf("line"),
    "g-bar": documentOf("bar"),
  };
  api.getById.mockImplementation(({ artifactId }: { artifactId: string }) =>
    Promise.resolve({ contentBase64: btoa(JSON.stringify(docs[artifactId])) }),
  );
  render(
    <ChartGallery
      messages={[chartMessage("g-kpi"), chartMessage("g-line"), chartMessage("g-bar")]}
    />,
  );
  expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(host.querySelector('[data-chart="kpi_card"]')?.textContent).toContain("$190,300");
  expect(host.querySelectorAll("[data-chart]").length).toBe(3);
  expect(host.textContent).toContain(docs["g-line"]?.spec.title);
  expect(host.textContent).not.toContain("JSON");
  // Every chart keeps its message id, so jumping to a message still lands on it.
  expect(host.querySelectorAll("[data-message-id]").length).toBe(3);
});

it("says a chart is unavailable when its file is not a chart", async () => {
  api.getById.mockResolvedValue({ contentBase64: btoa("not a chart") });
  render(<ChartGallery messages={[chartMessage("g-broken")]} />);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(host.textContent).toContain("Chart unavailable");
});

it("draws chart files as charts wherever a file card would show", () => {
  const args = { artifactId: "a", version: 1, data: {} };
  expect(chartsExtension.result?.({ ...args, name: "a.chart.json" })).not.toBeNull();
  expect(chartsExtension.result?.({ ...args, name: "a.pdf" })).toBeNull();
});
