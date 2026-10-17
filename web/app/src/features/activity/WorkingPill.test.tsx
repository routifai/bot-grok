// @vitest-environment jsdom

import type { Activity } from "@superchat/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("react-dom/client", async (orig) =>
  (await import("../../test/i18n")).withI18nRoot(await orig<typeof import("react-dom/client")>()),
);
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((acc, part, i) => `${acc}${part}${values[i] ?? ""}`, "");
  return {
    useLingui: () => ({ t, i18n: { locale: "en" } }),
    Trans: ({ children }: { children: ReactNode }) => children,
  };
});

const feed = vi.hoisted(() => ({ activities: [] as Activity[] }));
vi.mock("./useActivities", () => ({
  useActivities: () => ({
    state: { status: "ready", activities: feed.activities, hasMore: false },
    loadEarlier: async () => undefined,
    loadingEarlier: false,
  }),
}));

import { helper } from "./activityTestKit";
import { workingSince } from "./superchatWork";
import { WorkingPill } from "./WorkingPill";

const mounted: Array<() => void> = [];
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
  feed.activities = [];
});

async function mount(turnStartedAt: number | null) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(() => act(() => root.unmount()));
  const render = async (next: number | null) => {
    await act(async () => root.render(<WorkingPill botId="bot-1" turnStartedAt={next} />));
  };
  await render(turnStartedAt);
  return { container, render };
}

const pill = (container: HTMLElement) => container.querySelector("[data-testid=working-pill]");

it("shows Working with the time since the turn began, with the orb and its glowing ring", async () => {
  const { container } = await mount(Date.now() - 12_000);
  expect(pill(container)?.textContent).toMatch(/^Working · 0:1[23]$/);
  expect(pill(container)?.querySelector(".sc-live-ring")).not.toBeNull();
  expect(pill(container)?.querySelector("[data-testid=superchat-orb]")).not.toBeNull();
});

it("stays while a Helper runs after the turn ended, and is gone once everything settled", async () => {
  feed.activities = [
    helper("h1", { status: "in_progress", startedAt: new Date(Date.now() - 65_000).toISOString() }),
  ];
  const { container, render } = await mount(null);
  expect(pill(container)?.textContent).toMatch(/^Working · 1:0[56]$/);
  feed.activities = [helper("h1", { status: "done" })];
  await render(null);
  expect(pill(container)).toBeNull();
});

it("counts from the earliest running work", () => {
  const started = Date.parse("2026-10-17T10:00:00.000Z");
  expect(workingSince(null, [])).toBeNull();
  expect(
    workingSince(started + 5_000, [
      helper("h1", { status: "in_progress", startedAt: "2026-10-17T10:00:00.000Z" }),
    ]),
  ).toBe(started);
});
