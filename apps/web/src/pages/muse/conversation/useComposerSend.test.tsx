// @vitest-environment jsdom

import type { Bot, ComputerStatus } from "@nova/contracts";
import { ORPCError } from "@orpc/client";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

/** The Computer status stream the composer listens to, driven by the tests. */
const computerBus = (() => {
  const listeners = new Set<(status: ComputerStatus | null) => void>();
  const computerRef = { current: null as ComputerStatus | null };
  return {
    store: {
      computerRef,
      commitComputer: (next: ComputerStatus | null) => {
        computerRef.current = next;
        for (const listener of listeners) listener(next);
      },
      onComputerChange: (listener: (status: ComputerStatus | null) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    emit(status: Partial<ComputerStatus> | null) {
      this.store.commitComputer(status as ComputerStatus | null);
    },
    reset() {
      listeners.clear();
      computerRef.current = null;
    },
  };
})();
const STARTING = { state: "booting", launch: { stage: "starting" } } as const;
const UP = { state: "running", runnerReady: true } as const;

const api = vi.hoisted(() => ({
  files: { uploadAttachment: vi.fn(), ingestAttachment: vi.fn() },
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
    computerStore: computerBus.store,
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
  computerBus.reset();
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
  api.files.ingestAttachment.mockReset().mockImplementation(async (input: { path: string }) => ({
    fileId: "ab12",
    name: input.path.split("/").pop(),
    pages: 2,
    chars: 40,
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

const settled = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
const statuses = () => latest.pendingAttachments.map((a) => a.status);

it("uploads and reads each attachment when it is picked, then sends them as workspace attachments", async () => {
  await mount();
  await pickFiles(["a.pdf", "aaa", "application/pdf"], ["b.pdf", "bbb", "application/pdf"]);
  await settled();
  expect(statuses()).toEqual(["ready", "ready"]);
  expect(api.files.uploadAttachment).toHaveBeenCalledTimes(2);
  expect(api.files.uploadAttachment.mock.calls[0]?.[0]).toMatchObject({
    botId: BOT,
    name: "a.pdf",
    mimeType: "application/pdf",
    contentBase64: "YWFh",
  });
  expect(api.files.ingestAttachment.mock.calls.map((c) => c[0])).toEqual([
    { botId: BOT, path: "your_files/uploads/2026-10-09/a.pdf" },
    { botId: BOT, path: "your_files/uploads/2026-10-09/b.pdf" },
  ]);
  await act(async () => latest.sendMessage("read these"));
  expect(api.files.uploadAttachment).toHaveBeenCalledTimes(2); // not uploaded again at send
  expect(api.artifacts.create).not.toHaveBeenCalled();
  const sent = api.threads.send.mock.calls[0]?.[0];
  expect(sent.attachments).toEqual([
    expect.objectContaining({ path: "your_files/uploads/2026-10-09/a.pdf", name: "a.pdf" }),
    expect.objectContaining({ path: "your_files/uploads/2026-10-09/b.pdf", name: "b.pdf" }),
  ]);
  expect(latest.pendingAttachments).toHaveLength(0);
});

it("goes uploading, reading, ready, and holds the message back until then", async () => {
  await mount();
  let release: () => void = () => undefined;
  api.files.ingestAttachment.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ fileId: "ab12", name: "a.pdf", pages: 1, chars: 3 });
      }),
  );
  let finishUpload: () => void = () => undefined;
  api.files.uploadAttachment.mockImplementation(
    (input: { name: string }) =>
      new Promise((resolve) => {
        finishUpload = () =>
          resolve({
            path: `p/${input.name}`,
            name: input.name,
            mimeType: "application/pdf",
            size: 3,
          });
      }),
  );
  await pickFiles(["a.pdf", "aaa", "application/pdf"]);
  await settled();
  expect(statuses()).toEqual(["uploading"]);
  expect(await act(async () => latest.sendMessage("hi"))).toBe(false);
  await act(async () => finishUpload());
  await settled();
  expect(statuses()).toEqual(["reading"]);
  expect(await act(async () => latest.sendMessage("hi"))).toBe(false);
  expect(api.threads.send).not.toHaveBeenCalled();
  await act(async () => release());
  await settled();
  expect(statuses()).toEqual(["ready"]);
  expect(await act(async () => latest.sendMessage("hi"))).toBe(true);
});

it("waits for the Computer's own 'up' event while uploading, with no timer retry", async () => {
  vi.useFakeTimers();
  try {
    await mount();
    api.files.uploadAttachment
      .mockRejectedValueOnce(new ORPCError("SERVICE_UNAVAILABLE", { message: "starting" }))
      .mockResolvedValueOnce({
        path: "p/a.pdf",
        name: "a.pdf",
        mimeType: "application/pdf",
        size: 3,
      });
    await pickFiles(["a.pdf", "aaa", "application/pdf"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(statuses()).toEqual(["starting"]);
    expect(await act(async () => latest.sendMessage("hi"))).toBe(false); // Send stays held
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000); // a minute passes: nothing retries by itself
    });
    expect(api.files.uploadAttachment).toHaveBeenCalledTimes(1);
    expect(statuses()).toEqual(["starting"]);
    await act(async () => computerBus.emit(STARTING));
    expect(api.files.uploadAttachment).toHaveBeenCalledTimes(1);
    await act(async () => computerBus.emit(UP));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(api.files.uploadAttachment).toHaveBeenCalledTimes(2);
    expect(statuses()).toEqual(["ready"]);
  } finally {
    vi.useRealTimers();
  }
});

it("shows a calm error on the chip when the Computer never comes up, and retries", async () => {
  vi.useFakeTimers();
  try {
    await mount();
    api.files.uploadAttachment.mockRejectedValue(
      new ORPCError("SERVICE_UNAVAILABLE", { message: "starting" }),
    );
    await pickFiles(["a.pdf", "aaa", "application/pdf"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(125_000);
    });
    expect(statuses()).toEqual(["error"]);
    expect(latest.pendingAttachments[0]?.error).toBe(
      "Your Computer is starting. Try again in a moment.",
    );
    expect(api.files.uploadAttachment).toHaveBeenCalledTimes(1);
    expect(await act(async () => latest.sendMessage("hi"))).toBe(false);
    api.files.uploadAttachment.mockReset().mockResolvedValue({
      path: "p/a.pdf",
      name: "a.pdf",
      mimeType: "application/pdf",
      size: 3,
    });
    const failed = latest.pendingAttachments[0] as never;
    await act(async () => latest.retryAttachment(failed));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(statuses()).toEqual(["ready"]);
  } finally {
    vi.useRealTimers();
  }
});

it("keeps the draft and the file when reading fails, and lets the person retry or remove it", async () => {
  await mount();
  api.files.ingestAttachment.mockRejectedValueOnce(new Error("boom"));
  await pickFiles(["a.pdf", "aaa", "application/pdf"]);
  await settled();
  expect(statuses()).toEqual(["error"]);
  expect(latest.pendingAttachments[0]?.error).toBeTruthy();
  await act(async () => latest.retryAttachment(latest.pendingAttachments[0] as never));
  await settled();
  expect(statuses()).toEqual(["ready"]);
  expect(api.files.uploadAttachment).toHaveBeenCalledTimes(1); // the retry only reads again
  await act(async () => latest.removeAttachment(latest.pendingAttachments[0] as never));
  expect(latest.pendingAttachments).toHaveLength(0);
});

it("sends an image without reading it", async () => {
  await mount();
  await pickFiles(["p.png", "png", "image/png"]);
  await settled();
  expect(statuses()).toEqual(["ready"]);
  expect(api.files.ingestAttachment).not.toHaveBeenCalled();
});

it("makes one ingest call and follows the Computer's status while it wakes", async () => {
  await mount();
  let finish: () => void = () => undefined;
  api.files.ingestAttachment.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ fileId: "ab12", name: "a.pdf", pages: 1, chars: 3 });
      }),
  );
  computerBus.emit(STARTING);
  await pickFiles(["a.pdf", "aaa", "application/pdf"]);
  await settled();
  expect(statuses()).toEqual(["starting"]);
  expect(await act(async () => latest.sendMessage("hi"))).toBe(false);
  await act(async () => computerBus.emit(UP));
  expect(statuses()).toEqual(["reading"]);
  await act(async () => finish());
  await settled();
  expect(statuses()).toEqual(["ready"]);
  expect(api.files.ingestAttachment).toHaveBeenCalledTimes(1); // never retried by the page
});

it("cancels the wait and the read when the chip is removed", async () => {
  await mount();
  let signal: AbortSignal | undefined;
  api.files.ingestAttachment.mockImplementation(
    (_input: unknown, options?: { signal?: AbortSignal }) => {
      signal = options?.signal;
      return new Promise(() => undefined);
    },
  );
  await pickFiles(["a.pdf", "aaa", "application/pdf"]);
  await settled();
  expect(signal?.aborted).toBe(false);
  await act(async () => latest.removeAttachment(latest.pendingAttachments[0] as never));
  expect(signal?.aborted).toBe(true);
  expect(latest.pendingAttachments).toHaveLength(0);
});

it("cancels the wait for a starting Computer when the person leaves the chat", async () => {
  await mount();
  api.files.uploadAttachment.mockRejectedValue(
    new ORPCError("SERVICE_UNAVAILABLE", { message: "starting" }),
  );
  await pickFiles(["a.pdf", "aaa", "application/pdf"]);
  await settled();
  expect(statuses()).toEqual(["starting"]);
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  await act(async () => computerBus.emit(UP)); // too late: nobody is waiting any more
  expect(api.files.uploadAttachment).toHaveBeenCalledTimes(1);
});

it("says a slow read is slow, not that the Computer is starting", async () => {
  await mount();
  api.files.ingestAttachment.mockRejectedValueOnce(
    new ORPCError("GATEWAY_TIMEOUT", { message: "slow" }),
  );
  await pickFiles(["a.pdf", "aaa", "application/pdf"]);
  await settled();
  expect(statuses()).toEqual(["error"]);
  expect(latest.pendingAttachments[0]?.error).toBe(
    "Reading a.pdf is taking too long. Try again in a moment.",
  );
});

it("gives every picked attachment its own id, even for identical files picked together", async () => {
  await mount();
  await pickFiles(["a.pdf", "aaa", "application/pdf"], ["a.pdf", "aaa", "application/pdf"]);
  await settled();
  const ids = latest.pendingAttachments.map((a) => a.id);
  expect(new Set(ids).size).toBe(2);
  await pickFiles(["a.pdf", "aaa", "application/pdf"]);
  expect(new Set(latest.pendingAttachments.map((a) => a.id)).size).toBe(3);
});

it("decides a starting Computer by the error code, not by words in the message", async () => {
  await mount();
  api.files.ingestAttachment.mockRejectedValueOnce(
    new ORPCError("INTERNAL_SERVER_ERROR", { message: "omnigent read failed (503): starting" }),
  );
  await pickFiles(["a.pdf", "aaa", "application/pdf"]);
  await settled();
  expect(statuses()).toEqual(["error"]);
  expect(latest.pendingAttachments[0]?.error).not.toContain("Your Computer is starting");
});

it("does not wait for an 'up' event that already happened", async () => {
  await mount();
  api.files.uploadAttachment
    .mockRejectedValueOnce(new ORPCError("SERVICE_UNAVAILABLE", { message: "starting" }))
    .mockResolvedValueOnce({
      path: "p/a.pdf",
      name: "a.pdf",
      mimeType: "application/pdf",
      size: 3,
    });
  computerBus.emit(UP); // the Computer came up in the moment between the call and the wait
  await pickFiles(["a.pdf", "aaa", "application/pdf"]);
  await settled();
  expect(statuses()).toEqual(["ready"]);
  expect(api.files.uploadAttachment).toHaveBeenCalledTimes(2);
});
