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

import type { RoundSummary, ThreadMessage } from "@superchat/contracts";
import { helper } from "./activityTestKit";
import { runningRoundSince } from "./rounds";
import { noteServerClock, resetServerClock, workingSince } from "./superchatWork";
import { WorkingPill } from "./WorkingPill";
import { deriveWorkState, IDLE_TURN } from "./workState";
import { formatClock } from "./workStripState";

const mounted: Array<() => void> = [];
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
  resetServerClock();
  vi.useRealTimers();
});

/** The pill for the Conversation's work state with these Activities and this turn running. */
const workOf = (turnStartedAt: number | null, activities: Activity[] = []) =>
  deriveWorkState({
    turn: { ...IDLE_TURN, running: turnStartedAt !== null },
    sending: false,
    stopping: false,
    activities,
    turnStartedAt,
  });

async function mount(turnStartedAt: number | null, activities: Activity[] = []) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(() => act(() => root.unmount()));
  const render = async (next: number | null, nextActivities = activities) => {
    await act(async () => root.render(<WorkingPill work={workOf(next, nextActivities)} />));
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
  const { container, render } = await mount(null, [
    helper("h1", { status: "in_progress", startedAt: new Date(Date.now() - 65_000).toISOString() }),
  ]);
  expect(pill(container)?.textContent).toMatch(/^Working · 1:0[56]$/);
  await render(null, [helper("h1", { status: "done" })]);
  expect(pill(container)).toBeNull();
});

it("reads Paused, not a running clock, while Pause holds every running Helper", async () => {
  const startedAt = new Date(Date.now() - 65_000).toISOString();
  const held = (chat: string, paused: boolean) =>
    helper(chat, { status: "in_progress", startedAt, finishedAt: null, paused });
  const { container, render } = await mount(null, [held("h1", true), held("h2", false)]);
  // One still works: the clock runs.
  expect(pill(container)?.textContent).toMatch(/^Working · 1:0[56]$/);
  await render(null, [held("h1", true), held("h2", true)]);
  expect(pill(container)?.textContent).toBe("Paused");
  // The Conversation's own turn running is never paused.
  await render(Date.now() - 5_000, [held("h1", true), held("h2", true)]);
  expect(pill(container)?.textContent).toMatch(/^Working/);
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

it("keeps still when motion is reduced", async () => {
  const { container } = await mount(Date.now());
  expect(pill(container)?.className).toContain("motion-reduce:animate-none");
});

it("counts the running Round from its start, on the engine's clock", async () => {
  const sec = (s: number) => Date.UTC(2026, 9, 17, 10, 0, s);
  const round = (roundId: string, status: string, startedAt: number): RoundSummary => ({
    roundId,
    status,
    startedAt,
    live: null,
    helpers: 0,
    files: 0,
    steps: 0,
  });
  // Newest first: the running Round, then one that settled before it.
  const rounds = [round("r2", "running", sec(0)), round("r1", "done", sec(-90))];
  const ask: ThreadMessage = {
    id: "r2",
    threadId: "conv",
    seq: 0,
    role: "user",
    createdAt: new Date(sec(0)).toISOString(),
    blocks: [{ kind: "text", text: "Make the deck" }],
  };
  // The client clock runs 9 s ahead of the engine's.
  const skew = 9_000;
  vi.useFakeTimers({ toFake: ["Date"] });
  // Open on the earlier Round; the person's message arrives as it is sent.
  const earlier = { ...ask, id: "r1", createdAt: new Date(sec(-90)).toISOString() };
  vi.setSystemTime(sec(-1) + skew);
  noteServerClock([earlier]);
  vi.setSystemTime(sec(0) + skew);
  noteServerClock([earlier, ask]);
  vi.setSystemTime(sec(30) + skew);
  const { container } = await mount(runningRoundSince(rounds));
  expect(pill(container)?.textContent).toBe(`Working · ${formatClock(30_000)}`);
  // Nothing runs once the Round settled.
  expect(runningRoundSince([round("r1", "done", sec(-90))])).toBeNull();
});
