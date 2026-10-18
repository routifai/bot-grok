// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Activity, ActivityStep, ThreadMessage } from "@superchat/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

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
vi.mock("../artifacts", () => ({
  ArtifactPreviewThumbnail: ({ artifact }: { artifact: { name: string; version: number } }) => (
    <span data-testid="file-thumb">{`${artifact.name} v${artifact.version}`}</span>
  ),
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
vi.mock("./useActivities", () => ({ activityFeedFor: () => fake.feed }));

const rpcMock = vi.hoisted(() => {
  /** Each Helper's status stream: frames pushed by the test. */
  const streams = new Map<string, Array<(frame: unknown) => void>>();
  return {
    list: vi.fn(),
    get: vi.fn(),
    pauseHelpers: vi.fn(),
    resumeHelpers: vi.fn(),
    streams,
    status(chatId: string, frame: { status: string; blockedOn: string | null; paused?: boolean }) {
      for (const push of streams.get(chatId) ?? []) push(frame);
    },
    watchStatus: vi.fn(
      async ({ chatId }: { chatId: string }, { signal }: { signal: AbortSignal }) => {
        const queue: unknown[] = [];
        let wake: (() => void) | null = null;
        const push = (frame: unknown) => {
          queue.push(frame);
          wake?.();
        };
        streams.set(chatId, [...(streams.get(chatId) ?? []), push]);
        return (async function* () {
          while (!signal.aborted) {
            if (queue.length === 0) await new Promise<void>((resolve) => (wake = resolve));
            wake = null;
            while (queue.length > 0) yield queue.shift();
          }
        })();
      },
    ),
  };
});
vi.mock("../../lib/rpc", () => ({
  rpc: {
    artifacts: { list: rpcMock.list },
    activities: { get: rpcMock.get },
    chats: {
      watchStatus: rpcMock.watchStatus,
      pauseHelpers: rpcMock.pauseHelpers,
      resumeHelpers: rpcMock.resumeHelpers,
    },
  },
}));

/** The family stream: the engine says a file was saved. */
const family = vi.hoisted(() => {
  const listeners = new Set<(event: unknown) => void>();
  return {
    listeners,
    saved: () => {
      for (const listener of [...listeners]) listener({ type: "artifactsChanged", groupId: "g" });
    },
  };
});
vi.mock("../../lib/family-stream", () => ({
  watchFamily: (_botId: string, listener: (event: unknown) => void) => {
    family.listeners.add(listener);
    return () => family.listeners.delete(listener);
  },
}));

import { AnsweredWhileWorking, useAnsweredWhileWorking } from "./AnsweredWhileWorking";
import { settleActivityFocus, useActivityFocus } from "./activityFocus";
import { activity, helper } from "./activityTestKit";
import { resetConversationFiles } from "./conversationFiles";
import { setStepComment, stepCommentNow } from "./stepComment";
import { WorkStrip } from "./WorkStrip";
import type { PlanStep } from "./workPlan";
import type { StripHelper, StripTurn } from "./workStripState";

const mounted: Array<() => void> = [];
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
  fake.set({ status: "loading" });
  fake.refresh.mockClear();
  rpcMock.list.mockReset();
  rpcMock.get.mockReset();
  rpcMock.pauseHelpers.mockReset();
  rpcMock.resumeHelpers.mockReset();
  rpcMock.streams.clear();
  setStepComment(null);
  resetConversationFiles();
});

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function toolStep(tool: string, title: string, n: number): ActivityStep {
  return { itemId: `fc_${n}`, title, createdAt: ago(1_000), tool };
}

const ready = (activities: Activity[]) => ({ status: "ready", activities, hasMore: false });

let focusSeen: ReturnType<typeof useActivityFocus> = null;
function FocusProbe() {
  focusSeen = useActivityFocus();
  return null;
}

async function mount(
  helpers: StripHelper[],
  activities: Activity[],
  turn?: StripTurn,
  /** Anything in the Conversation runs (the work state). */
  lit = true,
) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fake.set(ready(activities));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(() => act(() => root.unmount()));
  const render = async (next: StripHelper[], nextTurn: StripTurn | undefined = turn) => {
    await act(async () => {
      root.render(
        <>
          <WorkStrip botId="bot-1" helpers={next} turn={nextTurn} lit={lit} />
          <FocusProbe />
        </>,
      );
    });
  };
  await render(helpers);
  return { container, render };
}

const deckHelper: StripHelper = {
  helperId: "h-deck",
  title: "Write the deck",
  status: "in_progress",
};
const readHelper: StripHelper = {
  helperId: "h-read",
  title: "Read the files",
  status: "in_progress",
};

it("shows one line per running Helper with its title, status and a ticking clock", async () => {
  const { container } = await mount(
    [deckHelper, readHelper],
    [
      helper("h-deck", {
        title: "Write the deck",
        status: "in_progress",
        startedAt: ago(72_000),
        finishedAt: null,
      }),
      helper("h-read", {
        title: "Read the files",
        status: "done",
        startedAt: ago(200_000),
        finishedAt: ago(100_000),
      }),
    ],
  );
  const strip = container.querySelector("[data-testid=work-strip]");
  expect(strip?.getAttribute("data-state")).toBe("working");
  const lines = container.querySelectorAll("[data-testid=work-strip-line]");
  expect(lines).toHaveLength(1);
  expect(lines[0]?.textContent).toContain("Write the deck");
  expect(lines[0]?.querySelector("[data-testid=work-strip-status]")?.textContent).toBe("· Working");
  expect(lines[0]?.querySelector("[data-testid=work-strip-elapsed]")?.textContent).toMatch(
    /^1:1[23]$/,
  );
  expect(container.querySelector("[data-testid=work-strip-details]")?.textContent).toBe(
    "Show details",
  );
});

it("shows the latest progress sentence instead of Working", async () => {
  const { container } = await mount(
    [deckHelper],
    [
      helper("h-deck", {
        status: "in_progress",
        startedAt: ago(10_000),
        finishedAt: null,
        steps: [
          toolStep("report_progress", "Read the three files", 1),
          toolStep("artifact_read", "Used artifact read", 2),
          toolStep("report_progress", "Slide 6 of 10 written", 3),
        ],
      }),
    ],
  );
  expect(container.querySelector("[data-testid=work-strip-status]")?.textContent).toBe(
    "· Slide 6 of 10 written",
  );
});

it("shows a flag at once with the warning glyph", async () => {
  const { container } = await mount(
    [deckHelper],
    [
      helper("h-deck", {
        status: "in_progress",
        startedAt: ago(10_000),
        finishedAt: null,
        steps: [toolStep("raise_flag", "Flagged: The ledger and the memo disagree on growth", 1)],
      }),
    ],
  );
  const flag = container.querySelector("[data-testid=work-strip-flag]");
  expect(flag?.textContent).toBe("The ledger and the memo disagree on growth");
  expect(flag?.querySelector("svg.text-warning")).not.toBeNull();
});

it("collapses to one Done line with the whole span once every Helper is done", async () => {
  const { container } = await mount(
    [deckHelper, readHelper],
    [
      helper("h-read", {
        status: "done",
        startedAt: "2026-10-03T11:00:00.000Z",
        finishedAt: "2026-10-03T11:01:00.000Z",
      }),
      helper("h-deck", {
        status: "done",
        startedAt: "2026-10-03T11:00:30.000Z",
        finishedAt: "2026-10-03T11:02:14.000Z",
      }),
    ],
  );
  expect(container.querySelector("[data-testid=work-strip]")?.getAttribute("data-state")).toBe(
    "settled",
  );
  expect(container.querySelectorAll("[data-testid=work-strip-line]")).toHaveLength(0);
  expect(container.querySelector("[data-testid=work-strip-settled]")?.textContent).toBe("Done");
  expect(container.querySelector("[data-testid=work-strip-clock]")?.textContent).toBe("2:14");
  expect(container.querySelector("[data-testid=work-strip-details]")).not.toBeNull();
});

/** A row of `artifacts.list` as the engine sends it: the newest version of each file, for the
 * whole account (the list does not scope by bot), with who saved that version and how. */
function fileRow(
  id: string,
  name: string,
  chatId: string | null,
  origin = "ai",
  version = 1,
): Record<string, unknown> {
  return {
    id,
    botId: "bot-1",
    runId: null,
    name,
    description: null,
    mimeType: "text/html",
    size: 2048,
    version,
    createdAt: ago(1_000),
    publish: null,
    origin,
    chatId,
  };
}

const saving = (helperId: string, status: "in_progress" | "done" = "in_progress") =>
  helper(helperId, {
    status,
    startedAt: ago(60_000),
    finishedAt: status === "done" ? ago(1_000) : null,
    steps: [toolStep("artifact_save", "Saved a file", 1)],
  });

const draftNames = (container: HTMLElement) =>
  [...container.querySelectorAll("[data-testid=work-strip-draft]")].map((node) => node.textContent);

it("shows a Helper's draft as a thumbnail filling in, then still when done", async () => {
  rpcMock.list.mockResolvedValue([
    fileRow("v-deck-3", "q3-lending.deck.html", "h-deck", "ai", 3),
    fileRow("v-notes-1", "notes.md", "conv", "ai"),
  ]);
  const running = saving("h-deck");
  const { container } = await mount([deckHelper], [running]);
  await act(async () => undefined);
  const draft = container.querySelector("[data-testid=work-strip-draft]");
  expect(draftNames(container)).toEqual(["q3-lending.deck.html v3"]);
  expect(draft?.hasAttribute("data-updating")).toBe(true);

  await act(async () => {
    fake.set(ready([{ ...running, status: "done", finishedAt: ago(0) }]));
  });
  expect(container.querySelector("[data-testid=work-strip]")?.getAttribute("data-state")).toBe(
    "settled",
  );
  const settled = container.querySelector("[data-testid=work-strip-draft]");
  expect(settled).not.toBeNull();
  expect(settled?.hasAttribute("data-updating")).toBe(false);
});

it("shows no draft for a file someone else saved or edited by hand", async () => {
  rpcMock.list.mockResolvedValue([
    fileRow("v-deck-2", "deck.html", null, "manual", 2),
    fileRow("v-memo-1", "memo.md", "h-other", "ai"),
  ]);
  const { container } = await mount([deckHelper], [saving("h-deck")]);
  await act(async () => undefined);
  expect(container.querySelector("[data-testid=work-strip-draft]")).toBeNull();
});

it("finds a draft however many newer files others saved, and an older file it updated", async () => {
  const others = Array.from({ length: 8 }, (_, i) => fileRow(`v-o${i}`, `o${i}.md`, "h-other"));
  rpcMock.list.mockResolvedValue([
    ...others,
    fileRow("v-deck-1", "deck.html", "h-deck", "ai"),
    fileRow("v-page-4", "page.html", "h-deck", "update", 4),
  ]);
  const { container } = await mount([deckHelper], [saving("h-deck")]);
  await act(async () => undefined);
  expect(draftNames(container)).toEqual(["deck.html v1", "page.html v4"]);
  expect(rpcMock.list).toHaveBeenCalledTimes(1);
});

it("drops a draft once its file is deleted", async () => {
  rpcMock.list.mockResolvedValue([fileRow("v-deck-1", "deck.html", "h-deck")]);
  const { container } = await mount(
    [{ ...deckHelper, status: "done" }],
    [saving("h-deck", "done")],
  );
  await act(async () => undefined);
  expect(draftNames(container)).toEqual(["deck.html v1"]);

  rpcMock.list.mockResolvedValue([]);
  await act(async () => family.saved());
  expect(draftNames(container)).toEqual([]);
});

it("looks for files once the Helpers saved, and again only when the engine says a file was saved", async () => {
  rpcMock.list.mockResolvedValue([fileRow("v-a", "a.html", "h-a")]);
  const nothingSaved = helper("h-b", { status: "in_progress", startedAt: ago(1_000) });
  await mount([{ ...deckHelper, helperId: "h-b" }], [nothingSaved]);
  await act(async () => undefined);
  expect(rpcMock.list).not.toHaveBeenCalled();

  const one = await mount([{ ...deckHelper, helperId: "h-a" }], [saving("h-a", "done")]);
  await act(async () => undefined);
  expect(draftNames(one.container)).toEqual(["a.html v1"]);
  expect(rpcMock.list).toHaveBeenCalledTimes(1);

  // The feed moving on asks for nothing more.
  await act(async () => fake.set(ready([saving("h-a", "done"), nothingSaved])));
  await act(async () => undefined);
  expect(rpcMock.list).toHaveBeenCalledTimes(1);

  rpcMock.list.mockResolvedValue([fileRow("v-a", "a.html", "h-a", "update", 2)]);
  await act(async () => family.saved());
  await act(async () => undefined);
  expect(rpcMock.list).toHaveBeenCalledTimes(2);
  expect(draftNames(one.container)).toEqual(["a.html v2"]);
});

it("goes still when nothing in the Conversation runs, though the feed has not caught up", async () => {
  const { container } = await mount(
    [deckHelper],
    [helper("h-deck", { status: "in_progress", startedAt: ago(5_000), finishedAt: null })],
    undefined,
    false,
  );
  const strip = container.querySelector("[data-testid=work-strip]");
  expect(strip?.getAttribute("data-state")).toBe("settled");
  expect(container.querySelector("[data-testid=work-strip-line]")).toBeNull();
});

it("Show details asks the Activity panel to open on the running Helper", async () => {
  const { container } = await mount(
    [readHelper, deckHelper],
    [
      helper("h-read", { status: "done", startedAt: ago(90_000), finishedAt: ago(30_000) }),
      helper("h-deck", { status: "in_progress", startedAt: ago(10_000), finishedAt: null }),
    ],
  );
  await act(async () => {
    container.querySelector<HTMLButtonElement>("[data-testid=work-strip-details]")?.click();
  });
  expect(focusSeen?.activityId).toBe("sub_agent:h-deck");
  await act(async () => settleActivityFocus(focusSeen?.nonce ?? 0));
  expect(focusSeen).toBeNull();
});

it("falls back to the transcript's status for a Helper the feed does not list", async () => {
  const { container } = await mount([{ ...deckHelper, status: "done" }], []);
  expect(container.querySelector("[data-testid=work-strip-settled]")?.textContent).toBe("Done");
  expect(fake.refresh).not.toHaveBeenCalled();

  const live = await mount([deckHelper], []);
  expect(live.container.querySelector("[data-testid=work-strip-line]")?.textContent).toContain(
    "Write the deck",
  );
  expect(fake.refresh).toHaveBeenCalled();
});

it("puts the quiet meta line under a reply given while the work continues", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const messages: ThreadMessage[] = [
    {
      id: "reply-1",
      threadId: "conv",
      seq: 0,
      role: "bot",
      blocks: [
        { kind: "text", text: "On it." },
        { ...deckHelper, kind: "helper" },
      ],
      createdAt: ago(60_000),
    },
    {
      id: "ask-2",
      threadId: "conv",
      seq: 1,
      role: "user",
      blocks: [{ kind: "text", text: "When is the committee?" }],
      createdAt: ago(20_000),
    },
    {
      id: "reply-2",
      threadId: "conv",
      seq: 2,
      role: "bot",
      blocks: [{ kind: "text", text: "Thursday at 10:00." }],
      createdAt: ago(19_000),
    },
  ];
  fake.set(
    ready([helper("h-deck", { status: "in_progress", startedAt: ago(59_000), finishedAt: null })]),
  );
  function Replies() {
    const answered = useAnsweredWhileWorking("bot-1", messages);
    return (
      <>
        {messages.map((message) => (
          <div key={message.id} data-id={message.id}>
            {answered.has(message.id) ? <AnsweredWhileWorking /> : null}
          </div>
        ))}
      </>
    );
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(() => act(() => root.unmount()));
  await act(async () => root.render(<Replies />));
  const lines = container.querySelectorAll("[data-testid=answered-while-working]");
  expect(lines).toHaveLength(1);
  expect(lines[0]?.closest("[data-id]")?.getAttribute("data-id")).toBe("reply-2");
  expect(lines[0]?.textContent).toBe("Answered while the work continues");
});

describe("the plan in the strip (ADR 0023)", () => {
  const step = (text: string, status: PlanStep["status"], added = false): PlanStep => ({
    text,
    status,
    added,
  });
  const PLAN = [
    step("Read the file", "done"),
    step("Build the slides", "doing"),
    step("Check the figures", "todo"),
  ];
  const running = (plan: PlanStep[]): StripTurn => ({
    plan,
    live: true,
    startedAt: Date.now() - 42_000,
    endedAt: null,
  });
  const steps = (container: HTMLElement) =>
    [...container.querySelectorAll("[data-testid=work-plan-step]")].map((li) => [
      li.textContent,
      li.getAttribute("data-status"),
    ]);

  it("draws each step by its status, the current one with the latest progress sentence", async () => {
    const { container } = await mount(
      [deckHelper],
      [
        helper("h-deck", {
          status: "in_progress",
          startedAt: ago(30_000),
          finishedAt: null,
          steps: [toolStep("report_progress", "Slide 3 of 6 written", 1)],
        }),
      ],
      running(PLAN),
    );
    // Live, the strip stops at the current step and names the next one under it.
    expect(steps(container)).toEqual([
      ["Read the file", "done"],
      ["Build the slidesSlide 3 of 6 writtenThen: Check the figures", "doing"],
    ]);
    expect(container.querySelector("[data-testid=work-plan-then]")?.textContent).toBe(
      "Then: Check the figures",
    );
    expect(container.querySelector("[data-testid=work-strip-now]")?.textContent).toBe(
      "Build the slides",
    );
    expect(container.querySelector("[data-testid=work-plan-progress]")?.textContent).toBe(
      "Slide 3 of 6 written",
    );
    expect(
      container.querySelector("[data-testid=work-strip-progress]")?.getAttribute("aria-valuenow"),
    ).toBe("1");
    expect(container.querySelector("[data-testid=work-strip-clock]")?.textContent).toMatch(
      /^0:4[23]$/,
    );
    // The plan replaces the per-Helper lines.
    expect(container.querySelector("[data-testid=work-strip-line]")).toBeNull();
  });

  it("updates in place when the plan is rendered again, marking an added step", async () => {
    const { container, render } = await mount([], [], running(PLAN));
    const strip = container.querySelector("[data-testid=work-strip]");
    await render(
      [],
      running([
        step("Read the file", "done"),
        step("Build the slides", "done"),
        step("Note the cut-off", "doing", true),
        step("Check the figures", "todo"),
      ]),
    );
    expect(container.querySelectorAll("[data-testid=work-strip]")).toHaveLength(1);
    expect(container.querySelector("[data-testid=work-strip]")).toBe(strip);
    expect(steps(container).map(([, status]) => status)).toEqual(["done", "done", "doing"]);
    const added = container.querySelectorAll("[data-added]");
    expect(added).toHaveLength(1);
    expect(added[0]?.textContent).toBe("Note the cut-offThen: Check the figures");
  });

  it("is lit while the work runs, without any Helper, and goes still when it settles", async () => {
    const { container, render } = await mount([], [], running(PLAN));
    const strip = () => container.querySelector("[data-testid=work-strip]");
    expect(strip()?.hasAttribute("data-live")).toBe(true);
    expect(strip()?.className).toContain("sc-work");
    expect(container.querySelector("[data-testid=superchat-orb]")).not.toBeNull();
    await render([], { ...running(PLAN), live: false, endedAt: Date.now() });
    expect(strip()?.hasAttribute("data-live")).toBe(false);
    expect(strip()?.getAttribute("data-state")).toBe("settled");
    expect(container.querySelector("[data-testid=work-strip-still]")).not.toBeNull();
    expect(container.querySelector("[data-testid=work-strip-progress]")).toBeNull();
  });

  it("settles to one line, the plan behind a Plan toggle that starts closed", async () => {
    const started = Date.now() - 150_000;
    const { container } = await mount([], [], {
      plan: PLAN,
      live: false,
      startedAt: started,
      endedAt: started + 150_000,
    });
    // The step running when the work finished counts as done; the one never started does not.
    expect(container.querySelector("[data-testid=work-strip-settled]")?.textContent).toBe(
      "2 of 3 done",
    );
    expect(container.querySelector("[data-testid=work-strip-clock]")?.textContent).toBe("2:30");
    expect(container.querySelector("[data-testid=work-plan]")).toBeNull();
    const toggle = container.querySelector<HTMLButtonElement>(
      "[data-testid=work-strip-plan-toggle]",
    );
    expect(toggle?.textContent).toBe("Plan");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    await act(async () => toggle?.click());
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(steps(container).map(([, status]) => status)).toEqual(["done", "done", "todo"]);
    await act(async () => toggle?.click());
    expect(container.querySelector("[data-testid=work-plan]")).toBeNull();
  });

  it("stops the turning edge, the glow, the shimmer and every slide under reduced motion", () => {
    const css = readFileSync(resolve(import.meta.dirname, "../../styles.css"), "utf8");
    const reduced = css.slice(css.indexOf("@property --sc-work-angle"));
    const block = reduced.slice(reduced.indexOf("@media (prefers-reduced-motion: reduce)"));
    for (const selector of [
      ".sc-work[data-live]::before",
      ".sc-work[data-live]::after",
      ".sc-live-ring",
      ".sc-work-thumb[data-updating]",
      ".sc-work-added",
      ".sc-work-flag",
      ".sc-work-in",
      ".sc-work-pop",
    ]) {
      expect(block.slice(0, block.indexOf("}"))).toContain(selector);
    }
    expect(block).toContain("animation: none");
  });
});

it("takes no draft from a file's studio turn, even one that saved", async () => {
  rpcMock.list.mockResolvedValue([fileRow("v-deck-4", "q3.deck.html", "studio-1", "ai", 4)]);
  const studioTurn = activity({
    id: "turn:studio-1:r1",
    source: "studio",
    chatId: "studio-1",
    artifact: { groupId: "g-deck", name: "q3.deck.html" },
    status: "in_progress",
    startedAt: ago(10_000),
    finishedAt: null,
    steps: [toolStep("artifact_save", "Saved a file", 1)],
  });
  const { container } = await mount(
    [{ helperId: "studio-1", title: "Studio", status: "done" }],
    [studioTurn],
  );
  await act(async () => undefined);
  expect(container.querySelector("[data-testid=work-strip-draft]")).toBeNull();
  expect(container.querySelector("[data-testid=work-strip]")?.getAttribute("data-state")).not.toBe(
    "working",
  );
});

describe("the engine's display (ADR 0027)", () => {
  const engineStep = (text: string, status: PlanStep["status"], active?: string): PlanStep => ({
    text,
    status,
    added: false,
    engine: true,
    ...(active ? { active } : {}),
  });

  it("keeps the engine's reading once settled: a step left doing is not ticked", async () => {
    const started = Date.now() - 60_000;
    const { container } = await mount([], [], {
      plan: [engineStep("Build", "done"), engineStep("Check", "not_checked")],
      live: false,
      startedAt: started,
      endedAt: started + 60_000,
    });
    expect(container.querySelector("[data-testid=work-strip-settled]")?.textContent).toBe(
      "1 of 2 done",
    );
  });

  it("heads the live strip with the current step's present tense", async () => {
    const { container } = await mount([], [], {
      plan: [
        engineStep("Build the deck", "doing", "Building the deck"),
        engineStep("Check", "todo"),
      ],
      live: true,
      startedAt: Date.now() - 5_000,
      endedAt: null,
    });
    expect(container.querySelector("[data-testid=work-strip-now]")?.textContent).toBe(
      "Building the deck",
    );
  });

  it("puts a step in the composer from Comment, naming the plan card", async () => {
    const { container } = await mount([], [], {
      plan: [engineStep("Read", "done"), engineStep("Build", "doing")],
      planId: "plan-1",
      live: true,
      startedAt: Date.now() - 5_000,
      endedAt: null,
    });
    const buttons = container.querySelectorAll<HTMLButtonElement>(
      "[data-testid=work-plan-comment]",
    );
    await act(async () => buttons[0]?.click());
    expect(stepCommentNow()).toEqual({
      botId: "bot-1",
      cardId: "plan-1",
      stepIndex: 0,
      text: "Read",
    });
  });

  it("says what the work did under the settled reply, and unfolds its steps in place", async () => {
    const turnActivity = activity({
      id: "turn:conv:r1",
      summaryLine: "Created 2 files, searched the web, and 12 more steps",
    });
    const other = activity({ id: "turn:conv:r0", summaryLine: "Read your files" });
    rpcMock.get.mockResolvedValue({
      ...turnActivity,
      steps: [
        toolStep("report_progress", "Researching the figures", 1),
        toolStep("web_search", "Searched the web", 2),
      ],
    });
    const started = Date.now() - 60_000;
    const { container } = await mount([], [other, turnActivity], {
      plan: [engineStep("Build", "done")],
      activityId: "turn:conv:r1",
      live: false,
      startedAt: started,
      endedAt: started + 60_000,
    });
    const line = container.querySelector<HTMLButtonElement>("[data-testid=work-strip-summary]");
    expect(line?.textContent).toBe("Created 2 files, searched the web, and 12 more steps");
    expect(line?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("[data-testid=work-strip-steps]")).toBeNull();
    await act(async () => line?.click());
    expect(rpcMock.get).toHaveBeenCalledWith({ botId: "bot-1", activityId: "turn:conv:r1" });
    const steps = container.querySelector("[data-testid=work-strip-steps]");
    expect(steps?.querySelector("[data-testid=story-heading]")?.textContent).toContain(
      "Researching the figures",
    );
    // "Show details" still opens the run page.
    expect(container.querySelector("[data-testid=work-strip-details]")).not.toBeNull();
    await act(async () => line?.click());
    expect(container.querySelector("[data-testid=work-strip-steps]")).toBeNull();
  });

  it("has no summary line without the reply's Activity", async () => {
    const started = Date.now() - 60_000;
    const { container } = await mount([], [activity({ summaryLine: "Read your files" })], {
      plan: [engineStep("Build", "done")],
      live: false,
      startedAt: started,
      endedAt: started + 60_000,
    });
    expect(container.querySelector("[data-testid=work-strip-summary]")).toBeNull();
  });

  it("shows the files the reply's own turn saved", async () => {
    rpcMock.list.mockResolvedValue([
      fileRow("a1", "rbc.deck.html", "conv", "ai"),
      fileRow("a2", "older.md", "conv", "ai"),
    ]);
    const started = Date.now() - 60_000;
    const { container } = await mount([], [], {
      plan: [engineStep("Build", "done")],
      files: ["a1"],
      live: false,
      startedAt: started,
      endedAt: started + 60_000,
    });
    await act(async () => undefined);
    await act(async () =>
      container.querySelector<HTMLButtonElement>("[data-testid=work-strip-plan-toggle]")?.click(),
    );
    expect(
      [...container.querySelectorAll("[data-testid=file-thumb]")].map((thumb) => thumb.textContent),
    ).toEqual(["rbc.deck.html v1"]);
  });

  const running = (paused?: boolean) =>
    helper("h-deck", {
      status: "in_progress",
      startedAt: ago(10_000),
      finishedAt: null,
      ...(paused === undefined ? {} : { paused }),
    });

  it("pauses the reply's running Helpers, reads Paused once held, and resumes them", async () => {
    let answer: (value: unknown) => void = () => undefined;
    rpcMock.pauseHelpers.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    rpcMock.resumeHelpers.mockResolvedValue({ resumed: ["h-deck"] });
    const { container } = await mount([deckHelper], [running()]);
    const pause = container.querySelector<HTMLButtonElement>("[data-testid=work-strip-pause]");
    expect(pause?.textContent).toBe("Pause");
    await act(async () => pause?.click());
    expect(rpcMock.pauseHelpers).toHaveBeenCalledWith({ botId: "bot-1", helperIds: ["h-deck"] });
    // While the call is on its way, the press stands in.
    expect(container.querySelector("[data-testid=work-strip-paused]")?.textContent).toBe(
      "Paused · Resume",
    );
    // The feed says it is held, then the call returns: the engine says from here on.
    await act(async () => fake.set(ready([running(true)])));
    await act(async () => answer({ paused: ["h-deck"] }));
    expect(container.querySelector("[data-testid=work-strip-paused]")).not.toBeNull();
    await act(async () =>
      container.querySelector<HTMLButtonElement>("[data-testid=work-strip-resume]")?.click(),
    );
    expect(rpcMock.resumeHelpers).toHaveBeenCalledWith({ botId: "bot-1", helperIds: ["h-deck"] });
    // The call returned and the feed still says held: Paused until it says otherwise.
    expect(container.querySelector("[data-testid=work-strip-paused]")).not.toBeNull();
    await act(async () => fake.set(ready([running(false)])));
    expect(container.querySelector("[data-testid=work-strip-pause]")).not.toBeNull();
    // No status stream per Helper: the feed the strip already reads says it all.
    expect(rpcMock.watchStatus).not.toHaveBeenCalled();
  });

  it("lets the press stand in for at most 10 seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      rpcMock.pauseHelpers.mockReturnValue(new Promise(() => undefined));
      const { container } = await mount([deckHelper], [running()]);
      await act(async () =>
        container.querySelector<HTMLButtonElement>("[data-testid=work-strip-pause]")?.click(),
      );
      expect(container.querySelector("[data-testid=work-strip-paused]")).not.toBeNull();
      await act(async () => vi.advanceTimersByTime(10_000));
      expect(container.querySelector("[data-testid=work-strip-pause]")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads Paused from the Helper's entry alone (paused elsewhere)", async () => {
    const { container } = await mount([deckHelper], [running(true)]);
    expect(container.querySelector("[data-testid=work-strip-paused]")).not.toBeNull();
  });

  it("offers no Pause without a running Helper", async () => {
    const { container } = await mount([], [], {
      plan: [engineStep("Build", "doing")],
      live: true,
      startedAt: Date.now() - 5_000,
      endedAt: null,
    });
    expect(container.querySelector("[data-testid=work-strip-pause]")).toBeNull();
  });
});
