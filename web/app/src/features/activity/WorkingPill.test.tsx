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

import type { ThreadMessage } from "@superchat/contracts";
import { helper } from "./activityTestKit";
import { noteServerClock, resetServerClock, workingSince } from "./superchatWork";
import { WorkingPill } from "./WorkingPill";
import { transcriptWork } from "./workPlan";
import { deriveWorkState, IDLE_TURN } from "./workState";
import { composeStrip, deriveWorkStrip, formatClock } from "./workStripState";

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

it("reads the same time as the running reply's strip, before and after a reload", async () => {
  const sec = (s: number) => new Date(Date.UTC(2026, 9, 17, 10, 0, s)).toISOString();
  const msg = (id: string, role: "user" | "bot", createdAt: string): ThreadMessage => ({
    id,
    threadId: "conv",
    seq: 0,
    role,
    createdAt,
    blocks:
      role === "user"
        ? [{ kind: "text", text: "Make the deck" }]
        : [
            {
              kind: "reply_card",
              card: "plan",
              id: "p",
              data: { items: [{ text: "Read", status: "doing" }] },
              fallback: "Read",
            },
          ],
  });
  const messages = [msg("ask", "user", sec(0)), msg("card", "bot", sec(5))];
  // The client clock runs 9 s ahead of the engine's.
  const skew = 9_000;
  vi.useFakeTimers({ toFake: ["Date"] });
  const agree = async () => {
    const work = transcriptWork(messages);
    const turn = work.turns.get("card");
    const now = Date.now();
    const strip = composeStrip(
      deriveWorkStrip([], [], now),
      [],
      { plan: turn?.plan ?? null, live: true, startedAt: turn?.startedAt ?? null, endedAt: null },
      now,
    );
    const { container } = await mount(work.runningSince ?? null);
    expect(pill(container)?.textContent).toBe(`Working · ${formatClock(strip.clockMs ?? -1)}`);
    return strip.clockMs;
  };
  // Open while the reply is written: the plan card arrives as it is written.
  vi.setSystemTime(Date.parse(sec(0)) + skew);
  noteServerClock(messages.slice(0, 1));
  vi.setSystemTime(Date.parse(sec(5)) + skew);
  noteServerClock(messages);
  vi.setSystemTime(Date.parse(sec(30)) + skew);
  expect(await agree()).toBe(30_000);
  // Reloaded: nothing learned yet, both count from the same start on the same clock.
  resetServerClock();
  noteServerClock(messages);
  await agree();
});
