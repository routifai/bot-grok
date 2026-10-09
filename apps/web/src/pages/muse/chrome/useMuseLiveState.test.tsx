// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type MuseLiveRun, type MuseLiveState, useMuseLiveState } from "./useMuseLiveState";

vi.mock("react-dom/client", async (orig) =>
  (await import("../../../test/i18n")).withI18nRoot(
    await orig<typeof import("react-dom/client")>(),
  ),
);

const api = vi.hoisted(() => ({ computer: { status: vi.fn() } }));
vi.mock("../../../lib/rpc", () => ({ rpc: api }));
vi.mock("../../../features/approvals", () => ({ useAsks: () => ({ count: 0 }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
let latest: MuseLiveState | undefined;

function Probe({ status }: { status: MuseLiveRun["status"] }) {
  latest = useMuseLiveState({ botId: "bot-1", runs: [{ id: "r1", status }], messages: [] });
  return null;
}

async function mount(status: MuseLiveRun["status"]) {
  await act(async () => {
    root.render(<Probe status={status} />);
  });
}

beforeEach(() => {
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
