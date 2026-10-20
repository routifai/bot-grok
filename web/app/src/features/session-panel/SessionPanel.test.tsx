// @vitest-environment jsdom

import type { Activity, Artifact } from "@superchat/contracts";
import type { ReactElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-dom/client", async (orig) =>
  (await import("../../test/i18n")).withI18nRoot(await orig<typeof import("react-dom/client")>()),
);
vi.mock("../artifacts", () => ({
  ArtifactPreviewThumbnail: ({ artifact }: { artifact: { name: string } }) => (
    <span data-testid="file-thumb">{artifact.name}</span>
  ),
}));
vi.mock("../../components/ai/orb", () => ({
  useIsDesktop: () => true,
  SuperchatOrb: () => <span data-testid="superchat-orb" />,
}));
const fake = vi.hoisted(() => {
  let snapshot: { state: unknown; loadingEarlier: boolean } = {
    state: { status: "loading" },
    loadingEarlier: false,
  };
  return {
    feed: {
      refresh: () => undefined,
      subscribe: () => () => undefined,
      getSnapshot: () => snapshot,
    },
    set(activities: Activity[]) {
      snapshot = { state: { status: "ready", activities, hasMore: false }, loadingEarlier: false };
    },
  };
});
vi.mock("../activity/useActivities", () => ({
  activityFeedFor: () => fake.feed,
  useActivities: () => ({
    state: fake.feed.getSnapshot().state,
    loadEarlier: async () => undefined,
    loadingEarlier: false,
  }),
}));
const rpcMock = vi.hoisted(() => ({ list: vi.fn(), round: vi.fn() }));
vi.mock("../../lib/rpc", () => ({
  rpc: { artifacts: { list: rpcMock.list }, chats: { round: rpcMock.round } },
}));
vi.mock("../../lib/family-stream", () => ({ watchFamily: () => () => undefined }));

import { activity, helper } from "../activity/activityTestKit";
import { madeFiles, resetConversationFiles } from "../activity/conversationFiles";
import { resetRounds } from "../activity/rounds";
import type { TranscriptWork, TurnWork } from "../activity/workPlan";
import { SessionPanel } from "./SessionPanel";
import {
  newestTurn,
  SESSION_PANEL_KEY,
  usedFamilies,
  useSessionPanelOpen,
} from "./sessionPanelState";

const mounted: Array<() => void> = [];
const stored = new Map<string, string>();
const memoryStorage = {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => void stored.set(key, value),
  removeItem: (key: string) => void stored.delete(key),
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("localStorage", memoryStorage);
});
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
  rpcMock.list.mockReset();
  rpcMock.round.mockReset();
  stored.clear();
  resetConversationFiles();
  resetRounds();
});

async function mount(node: ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(() => act(() => root.unmount()));
  await act(async () => root.render(node));
  return {
    container,
    render: (next: ReactElement) => act(async () => root.render(next)),
  };
}

const file = (id: string, name: string, origin: string, createdAt: string): Artifact => ({
  id,
  botId: "bot-1",
  runId: null,
  name,
  description: null,
  mimeType: "text/html",
  size: 10,
  version: 1,
  createdAt,
  origin,
  chatId: "conv",
});

const turn = (over: Partial<TurnWork> = {}): TurnWork => ({
  anchorId: "reply",
  activityId: null,
  files: [],
  helpers: [],
  startedAt: null,
  endedAt: null,
  last: true,
  ...over,
});

describe("readings", () => {
  it("follows the reply the newest messages belong to, never an older one", () => {
    const older = turn({ anchorId: "a", last: false });
    const running = turn({ anchorId: "b", last: true });
    const work: TranscriptWork = {
      turns: new Map([
        ["a", older],
        ["b", running],
      ]),
      drawn: new Set(),
    };
    expect(newestTurn(work)).toBe(running);
    // The newest reply has no strip at all: nothing, not the older one.
    expect(newestTurn({ turns: new Map([["a", older]]), drawn: new Set() })).toBeNull();
  });

  it("lists the files Superchat made, newest first", () => {
    const rows = [
      file("a", "old.md", "ai", "2026-10-01T00:00:00Z"),
      file("b", "upload.pdf", "manual", "2026-10-03T00:00:00Z"),
      file("c", "new.deck.html", "update", "2026-10-02T00:00:00Z"),
    ];
    expect(madeFiles(rows).map((row) => row.name)).toEqual(["new.deck.html", "old.md"]);
  });

  it("names the kinds of tool the engine says the work used, once each, never a studio's", () => {
    expect(
      usedFamilies([
        activity({ families: ["shell", "web"] }),
        helper("h1", { families: ["decks", "web"] }),
        activity({ id: "studio", source: "studio", families: ["browser"] }),
        activity({ id: "plain" }),
      ]),
    ).toEqual(["web", "decks", "shell"]);
  });
});

function OpenProbe({ running, seen }: { running: boolean; seen: (open: boolean) => void }) {
  const panel = useSessionPanelOpen(running);
  seen(panel.open);
  return (
    <>
      <button type="button" data-testid="close" onClick={panel.close} />
      <button type="button" data-testid="show" onClick={panel.show} />
    </>
  );
}

describe("opening", () => {
  it("opens when work runs, stays open after, and stays closed once closed (remembered)", async () => {
    let open = false;
    const seen = (value: boolean) => {
      open = value;
    };
    const { container, render } = await mount(<OpenProbe running={false} seen={seen} />);
    expect(open).toBe(false);
    await render(<OpenProbe running seen={seen} />);
    expect(open).toBe(true);
    await render(<OpenProbe running={false} seen={seen} />);
    expect(open).toBe(true);
    await act(async () =>
      container.querySelector<HTMLButtonElement>("[data-testid=close]")?.click(),
    );
    expect(open).toBe(false);
    expect(stored.get(SESSION_PANEL_KEY)).toBe("1");
    await render(<OpenProbe running seen={seen} />);
    expect(open).toBe(false);
    await act(async () =>
      container.querySelector<HTMLButtonElement>("[data-testid=show]")?.click(),
    );
    expect(open).toBe(true);
    expect(stored.has(SESSION_PANEL_KEY)).toBe(false);
  });

  it("starts closed for a viewer who closed it before", async () => {
    stored.set(SESSION_PANEL_KEY, "1");
    let open = true;
    await mount(<OpenProbe running seen={(value) => (open = value)} />);
    expect(open).toBe(false);
  });

  it("works without storage", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
    });
    let open = false;
    await mount(<OpenProbe running seen={(value) => (open = value)} />);
    expect(open).toBe(true);
  });
});

describe("the panel", () => {
  it("shows the outputs (the running Round's, else the Conversation's) and the tools used", async () => {
    rpcMock.list.mockResolvedValue([
      file("a", "notes.md", "ai", "2026-10-01T00:00:00Z"),
      file("b", "acme.deck.html", "ai", "2026-10-02T00:00:00Z"),
    ]);
    fake.set([activity({ families: ["web", "files"] })]);
    const { container, render } = await mount(
      <SessionPanel botId="bot-1" open onClose={() => undefined} />,
    );
    await act(async () => undefined);
    expect(container.querySelector("[data-testid=session-progress]")).toBeNull();
    expect(
      [...container.querySelectorAll("[data-testid=session-output]")].map((row) => row.textContent),
    ).toEqual(["acme.deck.htmlacme.deck.html", "notes.mdnotes.md"]);
    expect(
      [...container.querySelectorAll("[data-testid=session-used-family]")].map(
        (chip) => chip.textContent,
      ),
    ).toEqual(["Web search", "Files"]);
    // While a Round runs, its own files are the outputs, once the Library lists them.
    rpcMock.round.mockResolvedValue({
      roundId: "m1",
      status: "running",
      files: [
        { artifactId: "b", name: "acme.deck.html", version: 1, helperId: null },
        { artifactId: "unlisted", name: "draft.md", version: 1, helperId: null },
      ],
    });
    await render(<SessionPanel botId="bot-1" roundId="m1" open onClose={() => undefined} />);
    await act(async () => undefined);
    expect(rpcMock.round).toHaveBeenCalledWith({ botId: "bot-1", roundId: "m1" });
    expect(
      [...container.querySelectorAll("[data-testid=session-output]")].map((row) => row.textContent),
    ).toEqual(["acme.deck.htmlacme.deck.html"]);
  });

  it("draws nothing while closed, and closes from its button", async () => {
    rpcMock.list.mockResolvedValue([]);
    fake.set([]);
    const onClose = vi.fn();
    const closed = await mount(<SessionPanel botId="bot-1" open={false} onClose={onClose} />);
    expect(closed.container.querySelector("[data-testid=session-panel]")).toBeNull();
    const { container } = await mount(<SessionPanel botId="bot-1" open onClose={onClose} />);
    await act(async () =>
      container.querySelector<HTMLButtonElement>("[data-testid=session-panel-close]")?.click(),
    );
    expect(onClose).toHaveBeenCalled();
  });
});
