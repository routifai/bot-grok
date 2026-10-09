// @vitest-environment jsdom

import type { Bot, ComputerStatus } from "@nova/contracts";
import { act, type ReactNode } from "react";
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
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((acc, part, i) => `${acc}${part}${values[i] ?? ""}`, "");
  return {
    useLingui: () => ({ t, i18n: { locale: "en" } }),
    Trans: ({ children }: { children: ReactNode }) => children,
  };
});
vi.mock("../../../lib/browser-notifications", () => ({
  requestBrowserNotificationPermission: () => null,
}));
vi.mock("../intro", () => ({ markFirstRunSeen: vi.fn() }));
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

import { Composer } from "./Composer";
import { useComposerSend } from "./useComposerSend";

const BOT = "b".repeat(32);
const botRef = { current: BOT as string | undefined };
const groupRef = { current: undefined as string | undefined };
const roots: Root[] = [];
let latest: ReturnType<typeof useComposerSend>;

/** The real hook wired to the real Composer, the way Shell does it. */
function Wired() {
  latest = useComposerSend({
    target: {
      active: { id: BOT, notifyOnFinish: false } as Bot,
      groupId: undefined,
      inGroup: false,
      activeBotId: botRef,
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
  return (
    <Composer
      museMode
      running={false}
      sending={latest.sending}
      pendingAttachments={latest.activePendingAttachments}
      uploadStatus={latest.uploadStatus}
      fileInputRef={latest.fileInputRef}
      onAttachmentPick={latest.onAttachmentPick}
      onRemoveAttachment={latest.removeAttachment}
      onRetryAttachment={latest.retryAttachment}
      onSend={latest.sendMessage}
    />
  );
}

async function mountWithAttachmentAndText(text: string) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(<Wired />));
  const file = new File(["aaa"], "vendor-review.pdf", { type: "application/pdf", lastModified: 1 });
  await act(async () =>
    latest.onAttachmentPick(Object.assign([file], { item: () => file }) as never),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
  const box = host.querySelector("textarea") as HTMLTextAreaElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(box, text);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return { host, box };
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
  api.files.ingestAttachment.mockReset().mockResolvedValue({
    fileId: "ab12",
    name: "vendor-review.pdf",
    pages: 2,
    chars: 40,
  });
  api.threads.send.mockReset().mockResolvedValue({ runId: "r1", taskId: "t1" });
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = "";
});

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 150)));

async function press(box: HTMLTextAreaElement) {
  await act(async () => {
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  await settle();
}

async function click(host: HTMLElement) {
  await act(async () => (host.querySelector('button[aria-label="Send"]') as HTMLElement).click());
  await settle();
}

for (const how of ["Enter", "Send button"] as const) {
  it(`${how} sends the question with the attachment that was read when it was picked`, async () => {
    const { host, box } = await mountWithAttachmentAndText("what is the Northwind fee?");
    if (how === "Enter") await press(box);
    else await click(host);
    expect(api.files.uploadAttachment).toHaveBeenCalledTimes(1);
    expect(api.files.ingestAttachment).toHaveBeenCalledTimes(1);
    expect(api.threads.send).toHaveBeenCalledTimes(1);
    expect(api.threads.send.mock.calls[0]?.[0]).toMatchObject({
      botId: BOT,
      text: "what is the Northwind fee?",
    });
    expect(latest.pendingAttachments).toHaveLength(0);
    expect(box.value).toBe("");
  });
}

it("gives the draft back when sendMessage returns early without sending", async () => {
  const { host, box } = await mountWithAttachmentAndText("keep me");
  // The target vanished (thread switch): sendMessage bails out before it sends anything.
  botRef.current = undefined;
  try {
    await press(box);
  } finally {
    botRef.current = BOT;
  }
  expect(api.threads.send).not.toHaveBeenCalled();
  expect(box.value).toBe("keep me");
  expect(host.textContent).toContain("vendor-review.pdf");
});

it("shows Reading on the chip and keeps Send disabled until the file is ready", async () => {
  let release: () => void = () => undefined;
  api.files.ingestAttachment.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ fileId: "ab12", name: "vendor-review.pdf", pages: 2, chars: 40 });
      }),
  );
  const { host, box } = await mountWithAttachmentAndText("what is the fee?");
  const chip = host.querySelector('[data-testid="composer-attachment"]') as HTMLElement;
  expect(chip.dataset.status).toBe("reading");
  expect(chip.textContent).toContain("Reading vendor-review.pdf…");
  const sendButton = host.querySelector('button[aria-label="Send"]') as HTMLButtonElement;
  expect(sendButton.disabled).toBe(true);
  await press(box);
  expect(api.threads.send).not.toHaveBeenCalled();
  expect(box.value).toBe("what is the fee?");
  await act(async () => release());
  await settle();
  expect(chip.dataset.status).toBe("ready");
  expect(sendButton.disabled).toBe(false);
});

it("shows Starting your Computer on the chip while the Computer wakes", async () => {
  api.files.ingestAttachment.mockImplementation(() => new Promise(() => undefined));
  computerBus.emit(STARTING);
  const { host } = await mountWithAttachmentAndText("hi");
  const chip = host.querySelector('[data-testid="composer-attachment"]') as HTMLElement;
  expect(chip.dataset.status).toBe("starting");
  expect(chip.textContent).toContain("Starting your Computer…");
  expect(chip.textContent).not.toContain("Uploading");
  expect((host.querySelector('button[aria-label="Send"]') as HTMLButtonElement).disabled).toBe(
    true,
  );
});

it("shows a failure on the chip with Retry, and never loses the draft", async () => {
  api.files.ingestAttachment.mockRejectedValueOnce(new Error("boom"));
  const { host, box } = await mountWithAttachmentAndText("keep this");
  const chip = host.querySelector('[data-testid="composer-attachment"]') as HTMLElement;
  expect(chip.dataset.status).toBe("error");
  expect((host.querySelector('button[aria-label="Send"]') as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(box.value).toBe("keep this");
  const retry = Array.from(chip.querySelectorAll("button")).find((b) => b.textContent === "Retry");
  await act(async () => retry?.click());
  await settle();
  expect(chip.dataset.status).toBe("ready");
});
