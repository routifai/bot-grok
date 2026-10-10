// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { CHART_FIXTURES, type ChartDocument, DASHBOARD_FIXTURE } from "@nova/charts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ getById: vi.fn(), thumbnail: vi.fn() }));
vi.mock("../../lib/rpc", () => ({ rpc: { artifacts: api, charts: api } }));
vi.mock("../../lib/artifact-open", () => ({
  decodeArtifactBase64: (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)),
}));

import { ArtifactPanelProvider } from "../../components/cards/context";
import { ChartInlinePreview } from "./ChartArtifact";
import { ChartGallery, chartOfMessage } from "./ChartResult";
import { ChartThumbnail } from "./ChartThumbnail";
import { ChartView } from "./ChartView";
import { DashboardResult } from "./DashboardView";
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
  expect(api.getById).toHaveBeenCalledWith(
    { artifactId: "inline-1" },
    { signal: expect.any(AbortSignal) },
  );
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

it("shows a chart whose request failed as an error with Retry, never an endless skeleton", async () => {
  // The live bug: requests that never settle kept the whole set on skeletons.
  api.getById.mockRejectedValueOnce(new Error("Failed to fetch"));
  render(<ChartGallery messages={[chartMessage("g-offline")]} />);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(host.querySelector('[aria-busy="true"]')).toBeNull();
  expect(host.querySelector('[data-chart-state="error"]')?.textContent).toContain("Couldn't load");
  // The request carries a deadline, so one that never answers fails the same way.
  expect(api.getById.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  api.getById.mockResolvedValueOnce({ contentBase64: btoa(JSON.stringify(documentOf("bar"))) });
  const retry = [...host.querySelectorAll("button")].find((b) => b.textContent === "Retry");
  await act(async () => {
    retry?.click();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(host.querySelector('[data-chart="bar"]')).not.toBeNull();
  expect(api.getById).toHaveBeenCalledTimes(2);
});

it("draws chart files as charts wherever a file card would show", () => {
  const args = { artifactId: "a", version: 1, data: {} };
  expect(chartsExtension.result?.({ ...args, name: "a.chart.json" })).not.toBeNull();
  expect(chartsExtension.result?.({ ...args, name: "a.pdf" })).toBeNull();
});

const settle = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

it("draws a dashboard as one card: title, KPI row, interactive charts, Open to the panel", async () => {
  api.getById.mockResolvedValue({ contentBase64: btoa(JSON.stringify(DASHBOARD_FIXTURE)) });
  const panel = { openId: null, open: vi.fn(), close: vi.fn() };
  render(
    <ArtifactPanelProvider value={panel as never}>
      <DashboardResult artifactId="dash-1" name="sales-2026.dashboard.json" version={1} />
    </ArtifactPanelProvider>,
  );
  expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
  await settle();
  const card = host.querySelector('[data-dashboard="dash-1"]');
  expect(card?.querySelector("h3")?.textContent).toBe("Sales 2026");
  expect(card?.querySelectorAll('[data-chart="kpi_card"]').length).toBe(3);
  expect(card?.textContent).toContain("$16,156,500");
  for (const chart of DASHBOARD_FIXTURE.charts)
    expect(card?.textContent).toContain(chart.spec.title);
  // Each chart keeps its provenance.
  expect(card?.textContent).toContain("Source: region.csv");
  const open = [...host.querySelectorAll("button")].find((b) => b.textContent === "Open");
  act(() => open?.click());
  expect(panel.open).toHaveBeenCalledWith("dash-1", "Sales 2026");
});

it("shows a dashboard that could not load as an error with Retry", async () => {
  api.getById.mockRejectedValueOnce(new Error("Failed to fetch"));
  render(<DashboardResult artifactId="dash-2" name="q3.dashboard.json" version={1} />);
  await settle();
  expect(host.querySelector('[data-chart-state="error"]')?.textContent).toContain("q3");
  api.getById.mockResolvedValueOnce({ contentBase64: btoa(JSON.stringify(DASHBOARD_FIXTURE)) });
  const retry = [...host.querySelectorAll("button")].find((b) => b.textContent === "Retry");
  await act(async () => {
    retry?.click();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(host.querySelector('[data-dashboard="dash-2"]')).not.toBeNull();
});

it("claims dashboards: the chat card, the panel and the Library", () => {
  const args = { artifactId: "d", version: 1, data: {} };
  expect(chartsExtension.result?.({ ...args, name: "d.dashboard.json" })).not.toBeNull();
  expect(chartsExtension.card?.({ name: "d.dashboard.json" } as never)).toEqual({
    meta: "Dashboard",
  });
  expect(
    chartsExtension.thumbnail?.({ id: "d", name: "d.dashboard.json", version: 1 } as never),
  ).not.toBeNull();
});

it("shows a dashboard page live at full width, as tall as the page says, with Open", async () => {
  const page = "<!doctype html><title>Sales</title><h1>Sales 2025</h1>";
  api.getById.mockResolvedValue({ contentBase64: btoa(page) });
  const open = vi.fn();
  render(
    <ArtifactPanelProvider value={{ open } as never}>
      {chartsExtension.result?.({
        artifactId: "d1",
        name: "sales.dashboard.html",
        version: 7,
        data: {},
      })}
    </ArtifactPanelProvider>,
  );
  await act(async () => {});
  const card = host.querySelector("[data-dashboard-page]") as HTMLElement;
  expect(card.className).toContain("w-[48rem]");
  const frame = card.querySelector("iframe") as HTMLIFrameElement;
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
  expect(frame.getAttribute("srcdoc")).toContain("Sales 2025");

  const box = frame.parentElement as HTMLElement;
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "nova:dashboard-height", height: 910 },
        source: frame.contentWindow,
      }),
    );
  });
  expect(box.style.height).toBe("910px");
  // Another window cannot resize it.
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", { data: { type: "nova:dashboard-height", height: 20 } }),
    );
  });
  expect(box.style.height).toBe("910px");

  act(() => (card.querySelector("button[aria-label^='Open']") as HTMLButtonElement).click());
  expect(open).toHaveBeenCalledWith("d1");
  expect(chartsExtension.card({ name: "sales.dashboard.html" } as never)?.meta).toBe("Dashboard");
  expect(chartsExtension.result?.({ artifactId: "x", name: "page.html", data: {} })).toBeNull();
});
