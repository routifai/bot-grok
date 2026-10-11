// @vitest-environment jsdom

import type { ThreadMessage } from "@superchat/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  type MuseLiveRun,
  type MuseLiveState,
  useMuseLiveState,
  useTurnRuns,
  waitingKey,
} from "./useMuseLiveState";

vi.mock("react-dom/client", async (orig) =>
  (await import("../../../test/i18n")).withI18nRoot(
    await orig<typeof import("react-dom/client")>(),
  ),
);

const api = vi.hoisted(() => ({ computer: { status: vi.fn() } }));
vi.mock("../../../lib/rpc", () => ({ rpc: api }));
const notifyAsksChanged = vi.hoisted(() => vi.fn());
vi.mock("../../../features/approvals", () => ({
  useAsks: () => ({ count: 0 }),
  notifyAsksChanged,
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
let latest: MuseLiveState | undefined;

let probeMessages: ThreadMessage[] = [];

function Probe({ status }: { status: MuseLiveRun["status"] }) {
  latest = useMuseLiveState({
    botId: "bot-1",
    runs: [{ id: "r1", status }],
    messages: probeMessages,
  });
  return null;
}

async function mount(status: MuseLiveRun["status"]) {
  await act(async () => {
    root.render(<Probe status={status} />);
  });
}

beforeEach(() => {
  probeMessages = [];
  host = document.createElement("div");
  root = createRoot(host);
  latest = undefined;
  api.computer.status.mockReset();
});
afterEach(() => act(() => root.unmount()));

it("says the Computer is starting while a running turn waits on its launch", async () => {
  api.computer.status.mockResolvedValue({ launch: { stage: "starting" } });
  await mount("running");
  expect(latest?.label).toBe("Starting your Computer…");
});

it("keeps the usual label when there is no launch in progress", async () => {
  api.computer.status.mockResolvedValue({});
  await mount("leased");
  expect(latest?.label).toBe("Thinking…");
  await mount("running");
  expect(latest?.label).toBe("Working…");
});

it("does not call a failed launch a start", async () => {
  api.computer.status.mockResolvedValue({ launch: { stage: "failed" } });
  await mount("running");
  expect(latest?.label).toBe("Working…");
});

it("does not read the Computer while idle", async () => {
  await mount("completed");
  expect(api.computer.status).not.toHaveBeenCalled();
  expect(latest?.label).toBeUndefined();
});

it("returns the active run's real start from startedAt, falling back to createdAt", async () => {
  const { runStartMs } = await import("./useMuseLiveState");
  expect(
    runStartMs({ id: "r", status: "running", startedAt: "2026-01-01T00:00:00Z", createdAt: "x" }),
  ).toBe(Date.parse("2026-01-01T00:00:00Z"));
  expect(
    runStartMs({ id: "r", status: "running", startedAt: null, createdAt: "2026-01-01T00:01:00Z" }),
  ).toBe(Date.parse("2026-01-01T00:01:00Z"));
  expect(runStartMs({ id: "r", status: "running" })).toBeUndefined();
  expect(runStartMs(undefined)).toBeUndefined();
});

it("refetches the open Asks when a run starts waiting on the person", async () => {
  api.computer.status.mockResolvedValue({});
  await mount("running");
  notifyAsksChanged.mockClear();
  await mount("running");
  expect(notifyAsksChanged).not.toHaveBeenCalled();
  await mount("waiting_input");
  expect(notifyAsksChanged).toHaveBeenCalledWith("bot-1");
});

it("keys the waiting set by waiting runs and open ask blocks", () => {
  const ask = (status: string) =>
    ({ id: "m1", blocks: [{ kind: "text" }, { kind: "ask", status }] }) as never;
  expect(waitingKey([{ id: "r1", status: "running" }], [ask("answered")])).toBe("");
  expect(waitingKey([{ id: "r1", status: "waiting_input" }], [ask("pending")])).toBe("r1,m1#1");
});

const reply = (role: ThreadMessage["role"], blocks: ThreadMessage["blocks"]): ThreadMessage => ({
  id: `${role}-${blocks.length}`,
  threadId: "conv",
  seq: 0,
  role,
  blocks,
  createdAt: "2026-10-10T10:00:00.000Z",
});

it("names the step the Muse is on from what it has written since the person's last message", async () => {
  api.computer.status.mockResolvedValue({});
  probeMessages = [
    reply("user", [{ kind: "text", text: "find it" }]),
    reply("bot", [{ kind: "steps", steps: [{ label: "Search the web" }] } as never]),
  ];
  await mount("running");
  expect(latest?.label).toBe("Searching the web…");
  // A step from the turn before the person's message is not this turn's.
  probeMessages = [
    reply("bot", [{ kind: "steps", steps: [{ label: "Search the web" }] } as never]),
    reply("user", [{ kind: "text", text: "and again" }]),
  ];
  await mount("running");
  expect(latest?.label).toBe("Working…");
});

it("runs a turn only while it is running, from the moment it was first seen running", async () => {
  let runs: MuseLiveRun[] = [];
  function Turn({ running }: { running: boolean }) {
    runs = useTurnRuns("conversation:bot-1", running);
    return null;
  }
  await act(async () => root.render(<Turn running={false} />));
  expect(runs).toEqual([]);
  await act(async () => root.render(<Turn running />));
  const first = runs[0];
  expect(first).toMatchObject({ id: "conversation:bot-1", status: "running" });
  await act(async () => root.render(<Turn running />));
  expect(runs[0]?.startedAtMs).toBe(first?.startedAtMs);
  await act(async () => root.render(<Turn running={false} />));
  expect(runs).toEqual([]);
});
