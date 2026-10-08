// @vitest-environment jsdom

import type { Ask, Goal } from "@aiden/contracts";
import type * as UiWeb from "@aiden/ui-web";
import { ORPCError } from "@orpc/client";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  goals: { list: vi.fn() },
  asks: { list: vi.fn(), answer: vi.fn() },
  activities: { list: vi.fn(), get: vi.fn() },
  memory: {
    profile: vi.fn(),
    claims: vi.fn(),
    editClaim: vi.fn(),
    forgetClaim: vi.fn(),
    dailyNotes: vi.fn(),
    saveDailyNote: vi.fn(),
  },
  chats: { transcript: vi.fn() },
}));
vi.mock("../../../lib/rpc", () => ({ rpc: api }));
vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((acc, part, i) => `${acc}${part}${values[i] ?? ""}`, ""),
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((acc, part, i) => `${acc}${part}${values[i] ?? ""}`, "");
  return {
    useLingui: () => ({ t, i18n: { locale: "en" } }),
    Trans: ({ children }: { children: ReactNode }) => children,
  };
});
vi.mock("@aiden/ui-web", async (importOriginal) => ({
  ...(await importOriginal<typeof UiWeb>()),
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
  BotAvatar: ({ face }: { face?: string }) => (
    <div data-testid="context-panel-empty-face" data-face={face} />
  ),
  Button: (props: ComponentProps<"button">) => <button type="button" {...props} />,
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children, ...props }: ComponentProps<"button">) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
}));

import { ContextPanel, useContextPanelCollapsed } from "./ContextPanel";

function activitiesPage(overrides: { activities?: unknown[]; hasMore?: boolean } = {}) {
  return { activities: overrides.activities ?? [], hasMore: overrides.hasMore ?? false };
}

function openContextTab(container: HTMLElement) {
  return container.querySelector<HTMLButtonElement>("[data-testid='context-panel-tab-context']");
}

function ask(overrides: Partial<Ask> = {}): Ask {
  return {
    id: "ask-1",
    runId: "run-1",
    kind: "question",
    goalId: null,
    goalTitle: null,
    text: "Which evenings work?",
    choices: [{ id: "mon", label: "Monday" }],
    input: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function goal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "goal-1",
    botId: "bot-1",
    title: "Conversational Japanese before Kyoto",
    description: "",
    status: "active",
    due: null,
    checkInCrons: [],
    timezone: "UTC",
    tasks: [
      {
        id: "task-1",
        goalId: "goal-1",
        idx: 0,
        title: "Pick a course",
        status: "done",
        note: "",
        updatedAt: "2026-09-20T00:00:00.000Z",
      },
      {
        id: "task-2",
        goalId: "goal-1",
        idx: 1,
        title: "Daily practice streak",
        status: "in_progress",
        note: "",
        updatedAt: "2026-09-21T00:00:00.000Z",
      },
    ],
    openProposal: null,
    lastWorkedAt: "2026-09-24T00:00:00.000Z",
    nextWorkAt: null,
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z",
    ...overrides,
  };
}

async function renderPanel(props: Partial<Parameters<typeof ContextPanel>[0]> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onNavigate = vi.fn();
  const onOpenWaiting = vi.fn();
  await act(async () => {
    root.render(
      <ContextPanel
        botId="bot-1"
        museName="Nova"
        collapsed={false}
        onNavigate={onNavigate}
        onOpenWaiting={onOpenWaiting}
        {...props}
      />,
    );
  });
  return {
    container,
    onNavigate,
    onOpenWaiting,
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

// jsdom in this repo's vitest setup doesn't provide `window.localStorage` (see
// apps/web/src/lib/bots-sidebar-pref.test.ts), so each test stubs a fresh in-memory one —
// `window` and `globalThis` are the same object in jsdom, so this reaches the component too.
function stubLocalStorage(): void {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
  });
}

beforeEach(() => {
  // The panel's Activity and Memory tabs poll on mount regardless of which tab is active,
  // so every test needs a safe default even when it only cares about the Context tab.
  api.activities.list.mockReset().mockResolvedValue(activitiesPage());
  api.activities.get.mockReset();
  api.memory.claims.mockReset().mockResolvedValue({ claims: [] });
  api.memory.editClaim.mockReset();
  api.memory.forgetClaim.mockReset();
  api.memory.dailyNotes.mockReset().mockResolvedValue({ notes: [] });
  api.memory.saveDailyNote.mockReset();
  api.chats.transcript.mockReset();
  stubLocalStorage();
  // jsdom doesn't implement matchMedia, and the progress ring's draw-in reads it directly
  // (prefers-reduced-motion); requestAnimationFrame is stubbed to run synchronously so the
  // ring settles inside the same `act` as the render instead of leaking a pending timer.
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});

it("renders Asks, in-progress Goals, and upcoming Check-ins from the data it's given", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.asks.list.mockResolvedValue([ask({ text: "Which evenings work?" })]);
  api.goals.list.mockResolvedValue([
    goal({
      id: "goal-1",
      title: "Conversational Japanese before Kyoto",
      checkInCrons: ["0 9 * * 1-5"],
    }),
  ]);
  const page = await renderPanel();
  try {
    await act(async () => {
      openContextTab(page.container)?.click();
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(page.container.textContent).toContain("Which evenings work?");
      });
    });
    expect(page.container.querySelector("[data-testid='context-panel-asks']")).toBeTruthy();
    expect(page.container.querySelector("[data-testid='context-panel-goals']")).toBeTruthy();
    expect(page.container.textContent).toContain("Conversational Japanese before Kyoto");
    expect(page.container.textContent).toContain("Daily practice streak");
    // The ring shows done/total ("1/2": one done Task of two).
    expect(page.container.textContent).toContain("1/2");
    await act(async () => {
      await vi.waitFor(() => {
        expect(page.container.querySelector("[data-testid='context-panel-checkins']")).toBeTruthy();
      });
    });

    const askRow = page.container.querySelector<HTMLButtonElement>(
      "[data-testid='context-panel-ask-row']",
    );
    await act(async () => {
      askRow?.click();
    });
    expect(page.onOpenWaiting).toHaveBeenCalled();

    const goalCard = page.container.querySelector<HTMLElement>(
      "[data-testid='context-panel-goal-card']",
    );
    await act(async () => {
      goalCard?.click();
    });
    expect(page.onNavigate).toHaveBeenCalledWith("goals");

    const checkinRow = page.container.querySelector<HTMLButtonElement>(
      "[data-testid='context-panel-checkin-row']",
    );
    await act(async () => {
      checkinRow?.click();
    });
    expect(page.onNavigate).toHaveBeenCalledWith("goals");
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("shows a 'View all' action once there are more open Asks than fit", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.asks.list.mockResolvedValue([
    ask({ id: "ask-1", text: "One" }),
    ask({ id: "ask-2", text: "Two" }),
    ask({ id: "ask-3", text: "Three" }),
    ask({ id: "ask-4", text: "Four" }),
  ]);
  api.goals.list.mockResolvedValue([]);
  const page = await renderPanel();
  try {
    await act(async () => {
      openContextTab(page.container)?.click();
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(page.container.querySelector("[data-testid='context-panel-view-all']")).toBeTruthy();
      });
    });
    // Only 3 rows render even though there are 4 open Asks.
    expect(page.container.querySelectorAll("[data-testid='context-panel-ask-row']").length).toBe(3);
    // The section's count reflects every open Ask, not just the ones shown.
    expect(
      page.container.querySelector("[data-testid='context-panel-asks']")?.textContent,
    ).toContain("4");

    const viewAll = page.container.querySelector<HTMLButtonElement>(
      "[data-testid='context-panel-view-all']",
    );
    await act(async () => {
      viewAll?.click();
    });
    expect(page.onOpenWaiting).toHaveBeenCalled();
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("hides a section with nothing in it, and shows one quiet line (no face) when everything is empty", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.asks.list.mockResolvedValue([]);
  api.goals.list.mockResolvedValue([]);
  const page = await renderPanel();
  try {
    await act(async () => {
      openContextTab(page.container)?.click();
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(page.container.textContent).toContain("You're all caught up.");
      });
    });
    expect(page.container.querySelector("[data-testid='context-panel-asks']")).toBeNull();
    expect(page.container.querySelector("[data-testid='context-panel-goals']")).toBeNull();
    expect(page.container.querySelector("[data-testid='context-panel-checkins']")).toBeNull();
    expect(page.container.querySelector("[data-testid='context-panel-empty-face']")).toBeNull();
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("hides only the empty sections when some Goals have no check-ins", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.asks.list.mockResolvedValue([]);
  api.goals.list.mockResolvedValue([goal({ checkInCrons: [] })]);
  const page = await renderPanel();
  try {
    await act(async () => {
      openContextTab(page.container)?.click();
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(page.container.querySelector("[data-testid='context-panel-goals']")).toBeTruthy();
      });
    });
    expect(page.container.querySelector("[data-testid='context-panel-asks']")).toBeNull();
    expect(page.container.querySelector("[data-testid='context-panel-checkins']")).toBeNull();
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("shows the Muse's name once, in the identity header, and Connected once a poll lands", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.asks.list.mockResolvedValue([]);
  api.goals.list.mockResolvedValue([]);
  api.activities.list.mockResolvedValue(activitiesPage());
  const page = await renderPanel({ museName: "Aiden" });
  try {
    await act(async () => {
      await vi.waitFor(() => {
        expect(
          page.container.querySelector("[data-testid='context-panel-connection']")?.textContent,
        ).toBe("Connected");
      });
    });
    expect(
      page.container.querySelector("[data-testid='context-panel-muse-name']")?.textContent,
    ).toBe("Aiden");
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("shows the Activity tab by default, grouped by day", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.asks.list.mockResolvedValue([]);
  api.goals.list.mockResolvedValue([]);
  api.activities.list.mockResolvedValue(
    activitiesPage({
      activities: [
        {
          id: "act-1",
          kind: "turn",
          source: "turn",
          chatId: "chat-1",
          title: "Checked the budget totals",
          outcome: "Everything ties out.",
          summary: "Everything ties out.",
          status: "done",
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          date: new Date().toISOString().slice(0, 10),
        },
      ],
    }),
  );
  const page = await renderPanel();
  try {
    await act(async () => {
      await vi.waitFor(() => {
        expect(page.container.querySelector("[data-testid='activity-panel']")).toBeTruthy();
      });
    });
    expect(page.container.textContent).toContain("Checked the budget totals");
    expect(page.container.querySelector("[data-testid='context-panel-asks']")).toBeNull();
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("shows the calm Activity empty state — not an error — when the Muse has no Conversation yet", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.asks.list.mockResolvedValue([]);
  api.goals.list.mockResolvedValue([]);
  // NOT_FOUND here means "this Muse has no Conversation yet" (a brand new Muse) — the
  // normal state, not a failure.
  api.activities.list.mockRejectedValue(
    new ORPCError("NOT_FOUND", { message: "This Muse has no Conversation yet" }),
  );
  const page = await renderPanel();
  try {
    await act(async () => {
      await vi.waitFor(() => {
        expect(page.container.querySelector("[data-testid='activity-empty']")).toBeTruthy();
      });
    });
    expect(page.container.textContent).toContain("Nothing yet");
    expect(page.container.textContent).not.toContain("Could not load");
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("shows the Memory tab's sections when switched to", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.asks.list.mockResolvedValue([]);
  api.goals.list.mockResolvedValue([]);
  api.memory.claims.mockResolvedValue({
    claims: [
      {
        id: "c1",
        kind: "preference",
        text: "Prefers phone-first slide decks",
        origin: "said",
        personAuthored: false,
        date: 1_790_000_000,
      },
    ],
  });
  const page = await renderPanel();
  try {
    await act(async () => {
      page.container
        .querySelector<HTMLButtonElement>("[data-testid='context-panel-tab-memory']")
        ?.click();
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(page.container.querySelector("[data-testid='memory-panel']")).toBeTruthy();
      });
    });
    expect(page.container.textContent).toContain("Prefers phone-first slide decks");
    expect(page.container.textContent).not.toContain("[");
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("shows a one-line empty state when nothing is remembered yet", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.asks.list.mockResolvedValue([]);
  api.goals.list.mockResolvedValue([]);
  api.memory.claims.mockResolvedValue({ claims: [] });
  const page = await renderPanel();
  try {
    await act(async () => {
      page.container
        .querySelector<HTMLButtonElement>("[data-testid='context-panel-tab-memory']")
        ?.click();
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(page.container.querySelector("[data-testid='memory-empty']")).toBeTruthy();
      });
    });
    expect(page.container.textContent).toContain("Nothing remembered yet.");
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("shows the calm Memory empty state — not an error — when the Muse has no Conversation yet", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.asks.list.mockResolvedValue([]);
  api.goals.list.mockResolvedValue([]);
  api.memory.claims.mockRejectedValue(
    new ORPCError("NOT_FOUND", { message: "This Muse has no Conversation yet" }),
  );
  const page = await renderPanel();
  try {
    await act(async () => {
      page.container
        .querySelector<HTMLButtonElement>("[data-testid='context-panel-tab-memory']")
        ?.click();
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(page.container.querySelector("[data-testid='memory-empty']")).toBeTruthy();
      });
    });
    expect(page.container.textContent).toContain("Nothing remembered yet.");
    expect(page.container.textContent).not.toContain("Could not load");
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("persists the collapsed state across a remount", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

  function Harness() {
    const [collapsed, setCollapsed] = useContextPanelCollapsed();
    return (
      <div>
        <span data-testid="state">{collapsed ? "collapsed" : "open"}</span>
        <button type="button" onClick={() => setCollapsed(!collapsed)}>
          toggle
        </button>
      </div>
    );
  }

  const container = document.createElement("div");
  document.body.append(container);
  let root = createRoot(container);
  await act(async () => root.render(<Harness />));
  expect(container.querySelector("[data-testid='state']")?.textContent).toBe("open");

  await act(async () => {
    container.querySelector("button")?.click();
  });
  expect(container.querySelector("[data-testid='state']")?.textContent).toBe("collapsed");
  expect(window.localStorage.getItem("muse:context-panel-collapsed")).toBe("1");

  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
  expect(container.querySelector("[data-testid='state']")?.textContent).toBe("collapsed");

  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
