// @vitest-environment jsdom

import type { Bot } from "@nova/contracts";
import { ORPCError } from "@orpc/client";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  files: { uploadAttachment: vi.fn() },
  artifacts: { create: vi.fn() },
  threads: { send: vi.fn() },
  routines: { testRun: vi.fn() },
}));
vi.mock("../../../lib/rpc", () => ({ rpc: api }));
vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }));
vi.mock("react-dom/client", async (orig) =>
  (await import("../../../test/i18n")).withI18nRoot(
    await orig<typeof import("react-dom/client")>(),
  ),
);
vi.mock("../../../features/approvals", () => ({ notifyAsksChanged: vi.fn() }));
vi.mock("../../../lib/browser-notifications", () => ({
  requestBrowserNotificationPermission: () => null,
}));
vi.mock("../intro", () => ({ markFirstRunSeen: vi.fn() }));

import { useComposerSend } from "./useComposerSend";

const BOT = "b".repeat(32);
const roots: Root[] = [];
let latest: ReturnType<typeof useComposerSend>;

function Harness() {
  const ref = { current: BOT as string | undefined };
  const groupRef = { current: undefined as string | undefined };
  latest = useComposerSend({
    target: {
      active: { id: BOT, notifyOnFinish: false } as Bot,
      groupId: undefined,
      inGroup: false,
      activeBotId: ref,
      activeGroupId: groupRef,
    },
    userId: "u1",
    museMode: true,
    activeSnapshot: null,
    threadOps: {
      terminalRunReceipts: { current: new Map() } as never,
      refreshThreadRef: { current: async () => undefined } as never,
      refreshGroupThreadRef: { current: async () => undefined } as never,
      updateSnapshot: () => undefined,
    },
    roster: { botsRef: { current: [] }, refreshBots: async () => undefined },
    flushPendingBrowserNotifications: () => undefined,
    computerStore: { computerRef: { current: null }, commitComputer: () => undefined },
    focusPrompt: { cancelFocusPrompt: () => undefined, focusPromptBotIdRef: { current: null } },
  } as never);
  return null;
}

async function pickFiles(...files: [string, string, string][]) {
  const list = files.map(([n, b, t]) => new File([b], n, { type: t, lastModified: 1 }));
  await act(async () =>
    latest.onAttachmentPick(Object.assign(list, { item: (i: number) => list[i] ?? null }) as never),
  );
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    "URL",
    Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL() {} }),
  );
  api.files.uploadAttachment.mockReset().mockImplementation(async (input: { name: string }) => ({
    path: `your_files/uploads/2026-10-09/${input.name}`,
    name: input.name,
    mimeType: "application/pdf",
    size: 3,
  }));
  api.artifacts.create.mockReset();
  api.threads.send.mockReset().mockResolvedValue({ runId: "r1", taskId: "t1" });
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
});

async function mount() {
  const host = document.createElement("div");
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(<Harness />));
}

it("uploads each attachment to the Computer and sends them as workspace attachments", async () => {
  await mount();
  await pickFiles(["a.pdf", "aaa", "application/pdf"], ["b.pdf", "bbb", "application/pdf"]);
  expect(latest.pendingAttachments).toHaveLength(2);
  await act(async () => latest.sendMessage("read these"));
  expect(api.files.uploadAttachment).toHaveBeenCalledTimes(2);
  expect(api.files.uploadAttachment.mock.calls[0]?.[0]).toMatchObject({
    botId: BOT,
    name: "a.pdf",
    mimeType: "application/pdf",
    contentBase64: "YWFh",
  });
  expect(api.artifacts.create).not.toHaveBeenCalled();
  const sent = api.threads.send.mock.calls[0]?.[0];
  expect(sent.artifactIds).toBeUndefined();
  expect(sent.attachments).toEqual([
    expect.objectContaining({ path: "your_files/uploads/2026-10-09/a.pdf", name: "a.pdf" }),
    expect.objectContaining({ path: "your_files/uploads/2026-10-09/b.pdf", name: "b.pdf" }),
  ]);
  expect(latest.pendingAttachments).toHaveLength(0);
  expect(latest.uploadStatus).toBeNull();
});

it("shows upload progress while files are written", async () => {
  await mount();
  await pickFiles(["a.pdf", "aaa", "application/pdf"], ["b.pdf", "bbb", "application/pdf"]);
  let release: () => void = () => undefined;
  api.files.uploadAttachment.mockImplementation(
    (input: { name: string }) =>
      new Promise((resolve) => {
        release = () =>
          resolve({
            path: `p/${input.name}`,
            name: input.name,
            mimeType: "application/pdf",
            size: 3,
          });
      }),
  );
  let sending: Promise<void> = Promise.resolve();
  await act(async () => {
    sending = latest.sendMessage("");
  });
  expect(latest.uploadStatus).toBe("Uploading 1 of 2");
  const settle = () => new Promise((resolve) => setTimeout(resolve, 100));
  await act(async () => settle());
  await act(async () => {
    release();
    await settle();
  });
  expect(latest.uploadStatus).toBe("Uploading 2 of 2");
  await act(async () => {
    release();
    await settle();
  });
  await act(async () => sending);
  expect(latest.uploadStatus).toBeNull();
});

it("waits for a starting Computer, then uploads; nothing is uploaded twice", async () => {
  vi.useFakeTimers();
  try {
    await mount();
    await pickFiles(["a.pdf", "aaa", "application/pdf"], ["b.pdf", "bbb", "application/pdf"]);
    api.files.uploadAttachment
      .mockResolvedValueOnce({
        path: "p/a.pdf",
        name: "a.pdf",
        mimeType: "application/pdf",
        size: 3,
      })
      .mockRejectedValueOnce(new ORPCError("SERVICE_UNAVAILABLE", { message: "boom (503)" }))
      .mockRejectedValueOnce(new ORPCError("SERVICE_UNAVAILABLE", { message: "boom (503)" }))
      .mockResolvedValueOnce({
        path: "p/b.pdf",
        name: "b.pdf",
        mimeType: "application/pdf",
        size: 3,
      });
    let sending: Promise<void> = Promise.resolve();
    await act(async () => {
      sending = latest.sendMessage("hi");
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(latest.uploadStatus).toBe("Starting your Computer…");
    expect(latest.sendError).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7000);
      await sending;
    });
    const names = api.files.uploadAttachment.mock.calls.map((call) => call[0].name);
    expect(names).toEqual(["a.pdf", "b.pdf", "b.pdf", "b.pdf"]);
    expect(
      api.threads.send.mock.calls[0]?.[0].attachments.map((a: { path: string }) => a.path),
    ).toEqual(["p/a.pdf", "p/b.pdf"]);
    expect(latest.sendError).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

it("keeps the files and fails calmly when the Computer never starts", async () => {
  vi.useFakeTimers();
  try {
    await mount();
    await pickFiles(["a.pdf", "aaa", "application/pdf"]);
    api.files.uploadAttachment.mockRejectedValue(
      new ORPCError("SERVICE_UNAVAILABLE", { message: "boom (503)" }),
    );
    await act(async () => {
      const sending = latest.sendMessage("hi");
      await vi.advanceTimersByTimeAsync(125_000);
      await sending;
    });
    expect(latest.sendError).toBe("Your Computer is starting. Try again in a moment.");
    expect(latest.pendingAttachments).toHaveLength(1);
    expect(api.threads.send).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
