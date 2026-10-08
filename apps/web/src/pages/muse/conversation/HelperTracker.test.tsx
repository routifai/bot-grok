// @vitest-environment jsdom

import type { Activity } from "@aiden/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("react-dom/client", async (orig) =>
  (await import("../../../test/i18n")).withI18nRoot(
    await orig<typeof import("react-dom/client")>(),
  ),
);

import type { ActivitiesState } from "../chrome/activityFeed";
import { helper, step } from "../chrome/activityTestKit";
import { HelperTracker } from "./HelperTracker";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((acc, part, i) => `${acc}${part}${values[i] ?? ""}`, "");
  return {
    useLingui: () => ({ t, i18n: { locale: "en" } }),
    Trans: ({ children }: { children: ReactNode }) => children,
  };
});
vi.mock("@lingui/core/macro", () => ({
  plural: (n: number, forms: { one: string; other: string }) =>
    (n === 1 ? forms.one : forms.other).replace("#", String(n)),
}));
vi.mock("../chrome/ActivityRunDialog", () => ({
  ActivityRunDialog: ({ activity }: { activity: Activity | null }) =>
    activity ? <div data-testid="run-dialog">{activity.title}</div> : null,
}));

const fake = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const refresh = vi.fn();
  let snapshot: { state: unknown; loadingEarlier: boolean } = {
    state: { status: "loading" },
    loadingEarlier: false,
  };
  return {
    refresh,
    feed: {
      refresh,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      getSnapshot: () => snapshot,
    },
    set(state: unknown) {
      snapshot = { state, loadingEarlier: false };
      for (const listener of [...listeners]) listener();
    },
  };
});
vi.mock("../chrome/useActivities", () => ({
  activityFeedFor: () => fake.feed,
  LIVE_ACTIVITY_WIRE: {},
}));

const mounted: Array<() => void> = [];
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
  fake.set({ status: "loading" });
  fake.refresh.mockClear();
});

const ready = (activities: Activity[]): ActivitiesState => ({
  status: "ready",
  activities,
  hasMore: false,
});

async function mount(props: { helperId?: string; title?: string } = {}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(() => act(() => root.unmount()));
  await act(async () => {
    root.render(
      <HelperTracker
        botId="bot-1"
        helperId={props.helperId ?? "lead"}
        title={props.title ?? "Japan trip"}
      />,
    );
  });
  return container;
}

const NOW = Date.parse("2026-10-03T11:22:20.000Z");
const startedAt = "2026-10-03T11:21:00.000Z";

it("shows the Helper's title plainly until the feed lists it, and asks the feed to look again", async () => {
  const container = await mount();
  expect(container.textContent).toContain("Japan trip");
  expect(container.querySelector("[data-testid=helper-tracker-row]")).toBeNull();

  await act(async () => fake.set(ready([])));
  expect(fake.refresh).toHaveBeenCalled();
  expect(container.textContent).toContain("Japan trip");
});

it("shows a running Helper at once: its live step, a step count and how long it has been going", async () => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date", "setInterval", "clearInterval"] });
  try {
    await act(async () =>
      fake.set(
        ready([
          helper("lead", {
            title: "Researching Japan trip",
            status: "in_progress",
            finishedAt: null,
            startedAt,
            steps: [step("Searched the web", 1), step("Read a travel guide", 2)],
          }),
        ]),
      ),
    );
    const container = await mount();
    const row = container.querySelector("[data-testid=helper-tracker-row]");
    expect(row?.getAttribute("data-status")).toBe("in_progress");
    expect(row?.textContent).toContain("Researching Japan trip");
    expect(row?.textContent).toContain("2 steps");
    expect(row?.textContent).toContain("1m 20s");
    expect(row?.textContent).toContain("Read a travel guide");
  } finally {
    vi.useRealTimers();
  }
});

it("starts a Helper that has taken no step yet as Starting, not done", async () => {
  await act(async () =>
    fake.set(ready([helper("lead", { status: "in_progress", finishedAt: null, startedAt })])),
  );
  const container = await mount();
  expect(container.textContent).toContain("Starting");
  expect(container.querySelector("[data-status=in_progress]")).not.toBeNull();
});

it("settles in place when the result lands: same row, now done, with its total time", async () => {
  const running = helper("lead", {
    title: "Researching Japan trip",
    status: "in_progress",
    finishedAt: null,
    startedAt,
    steps: [step("Searched the web", 1)],
  });
  await act(async () => fake.set(ready([running])));
  const container = await mount();
  const before = container.querySelector("[data-testid=helper-tracker-row]");

  await act(async () =>
    fake.set(
      ready([
        {
          ...running,
          status: "done",
          finishedAt: "2026-10-03T11:22:20.000Z",
          steps: [step("Searched the web", 1), step("Wrote it up", 2)],
        },
      ]),
    ),
  );
  const after = container.querySelectorAll("[data-testid=helper-tracker-row]");
  expect(after).toHaveLength(1);
  expect(after[0]).toBe(before);
  expect(after[0]?.getAttribute("data-status")).toBe("done");
  expect(after[0]?.textContent).toContain("Researching Japan trip");
  expect(after[0]?.textContent).toContain("2 steps · 1m 20s");
  expect(container.textContent).not.toContain("Wrote it up");
});

it("nests the parts a Helper handed on beneath it as smaller rows", async () => {
  await act(async () =>
    fake.set(
      ready([
        helper("lead", {
          title: "Plan the trip",
          status: "in_progress",
          finishedAt: null,
          startedAt,
        }),
        helper("flights", {
          parentChatId: "lead",
          title: "Find flights",
          status: "in_progress",
          finishedAt: null,
          startedAt,
        }),
        helper("hotels", { parentChatId: "lead", title: "Find hotels", startedAt }),
      ]),
    ),
  );
  const container = await mount();
  const rows = [...container.querySelectorAll("[data-testid=helper-tracker-row]")];
  expect(
    rows.map((row) => row.querySelector("[data-testid=activity-line-title]")?.textContent),
  ).toEqual(["Plan the trip", "Find flights", "Find hotels"]);
});

it("opens that Helper's run page when its row is clicked, and a part's own when a part is", async () => {
  await act(async () =>
    fake.set(
      ready([
        helper("lead", { title: "Plan the trip", startedAt }),
        helper("flights", { parentChatId: "lead", title: "Find flights", startedAt }),
      ]),
    ),
  );
  const container = await mount();
  const rows = container.querySelectorAll<HTMLElement>("[data-testid=helper-tracker-row]");
  await act(async () => rows[1]?.click());
  expect(container.querySelector("[data-testid=run-dialog]")?.textContent).toBe("Find flights");
});

it("shows a Helper that did not finish in plain words", async () => {
  await act(async () =>
    fake.set(ready([helper("lead", { title: "Plan the trip", status: "failed", startedAt })])),
  );
  const container = await mount();
  const row = container.querySelector("[data-testid=helper-tracker-row]");
  expect(row?.querySelector("[data-testid=activity-line-title]")?.textContent).toBe(
    "Plan the trip",
  );
  expect(row?.textContent).toContain("Didn't finish");
});

it("never shows an engine name: the Helper's own words come through the title presenter", async () => {
  await act(async () =>
    fake.set(ready([helper("lead", { title: "researcher: Japan trip", startedAt })])),
  );
  const container = await mount();
  expect(container.textContent).toContain("Japan trip");
  expect(container.textContent).not.toContain("researcher");
});
