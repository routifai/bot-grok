// @vitest-environment jsdom

import type { Activity, ActivityStep, ThreadMessage } from "@superchat/contracts";
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
vi.mock("../artifacts", () => ({
  ReplyArtifactFileCard: ({
    data,
    updating,
  }: {
    data: { name: string; version: number };
    updating?: boolean;
  }) => (
    <div data-testid="file-card" data-updating={String(Boolean(updating))}>
      {`${data.name} v${data.version}`}
    </div>
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

const rpcMock = vi.hoisted(() => ({
  list: vi.fn(),
  listVersions: vi.fn(),
}));
vi.mock("../../lib/rpc", () => ({
  rpc: { artifacts: { list: rpcMock.list, listVersions: rpcMock.listVersions } },
}));

import { AnsweredWhileWorking, useAnsweredWhileWorking } from "./AnsweredWhileWorking";
import { settleActivityFocus, useActivityFocus } from "./activityFocus";
import { helper } from "./activityTestKit";
import { WorkStrip } from "./WorkStrip";
import type { StripHelper } from "./workStripState";

const mounted: Array<() => void> = [];
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
  fake.set({ status: "loading" });
  fake.refresh.mockClear();
  rpcMock.list.mockReset();
  rpcMock.listVersions.mockReset();
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

async function mount(helpers: StripHelper[], activities: Activity[]) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fake.set(ready(activities));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(() => act(() => root.unmount()));
  const render = async (next: StripHelper[]) => {
    await act(async () => {
      root.render(
        <>
          <WorkStrip botId="bot-1" helpers={next} />
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
  expect(container.querySelector("[data-testid=work-strip-settled]")?.textContent).toBe(
    "Done · 2:14",
  );
  expect(container.querySelector("[data-testid=work-strip-details]")).not.toBeNull();
});

it("shows a Helper's draft as the file card marked Updating, then the plain card when done", async () => {
  rpcMock.list.mockResolvedValue([
    {
      id: "art-deck",
      name: "q3-lending.deck.html",
      version: 3,
      size: 2048,
      createdAt: ago(1_000),
    },
    { id: "art-old", name: "notes.md", version: 1, size: 10, createdAt: ago(3_600_000) },
  ]);
  rpcMock.listVersions.mockResolvedValue([
    {
      id: "v3",
      version: 3,
      name: "q3-lending.deck.html",
      createdAt: ago(1_000),
      origin: "ai",
      chatId: "h-deck",
    },
  ]);
  const running = helper("h-deck", {
    status: "in_progress",
    startedAt: ago(60_000),
    finishedAt: null,
    steps: [toolStep("artifact_save", "Saved 'Q3 lending'", 1)],
  });
  const { container } = await mount([deckHelper], [running]);
  await act(async () => undefined);
  expect(rpcMock.listVersions).toHaveBeenCalledTimes(1);
  const card = container.querySelector("[data-testid=file-card]");
  expect(card?.textContent).toBe("q3-lending.deck.html v3");
  expect(card?.getAttribute("data-updating")).toBe("true");

  await act(async () => {
    fake.set(ready([{ ...running, status: "done", finishedAt: ago(0) }]));
  });
  expect(container.querySelector("[data-testid=work-strip]")?.getAttribute("data-state")).toBe(
    "settled",
  );
  expect(container.querySelector("[data-testid=file-card]")?.getAttribute("data-updating")).toBe(
    "false",
  );
});

it("shows no draft for a file someone else saved", async () => {
  rpcMock.list.mockResolvedValue([
    { id: "art-deck", name: "deck.html", version: 2, size: 1, createdAt: ago(1_000) },
  ]);
  rpcMock.listVersions.mockResolvedValue([
    {
      id: "v2",
      version: 2,
      name: "deck.html",
      createdAt: ago(1_000),
      origin: "manual",
      chatId: null,
    },
  ]);
  const { container } = await mount(
    [deckHelper],
    [
      helper("h-deck", {
        status: "in_progress",
        startedAt: ago(60_000),
        finishedAt: null,
        steps: [toolStep("artifact_save", "Saved 'deck'", 1)],
      }),
    ],
  );
  await act(async () => undefined);
  expect(container.querySelector("[data-testid=file-card]")).toBeNull();
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
