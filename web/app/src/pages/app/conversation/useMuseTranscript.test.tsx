// @vitest-environment jsdom

import type { FamilyEvent, ThreadMessage, ThreadMessagePage } from "@superchat/contracts";
import { act, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  chats: { transcript: vi.fn(), markRead: vi.fn(async () => ({ ok: true })) },
}));
const family = vi.hoisted(() => ({ listener: null as ((event: FamilyEvent) => void) | null }));
vi.mock("../../../lib/rpc", () => ({ rpc: api }));
vi.mock("../../../lib/family-stream", () => ({
  watchFamily: (_botId: string, listener: (event: FamilyEvent) => void) => {
    family.listener = listener;
    return () => undefined;
  },
}));

import { useMuseTranscript } from "./useMuseTranscript";

const message = (id: string, role: ThreadMessage["role"] = "user"): ThreadMessage => ({
  id,
  threadId: "conv",
  seq: 0,
  role,
  blocks: [{ kind: "text", text: id }],
  createdAt: "2026-10-03T10:00:00.000Z",
});
const page = (ids: string[], extra: Partial<ThreadMessagePage> = {}): ThreadMessagePage => ({
  threadId: "conv",
  messages: ids.map((id) => message(id)),
  olderCursor: null,
  ...extra,
});

let latest: ReturnType<typeof useMuseTranscript>;
const scrollRef: RefObject<HTMLElement | null> = { current: null };
function Harness() {
  latest = useMuseTranscript("bot-1", scrollRef);
  return null;
}
const roots: Root[] = [];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  api.chats.transcript.mockReset();
  api.chats.markRead.mockClear();
  family.listener = null;
  vi.useFakeTimers();
});
afterEach(async () => {
  vi.useRealTimers();
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
});

async function mountHook() {
  const root = createRoot(document.createElement("div"));
  roots.push(root);
  await act(async () => {
    root.render(<Harness />);
  });
  await act(async () => {});
}

it("offers the earlier history after a clear, pages it before the reset, and drops it on the next clear", async () => {
  api.chats.transcript.mockResolvedValueOnce(
    page(["new-1"], { reset: { itemId: "r1", createdAt: "2026-10-03T10:00:00.000Z" } }),
  );
  await mountHook();
  expect(latest.canShowEarlier).toBe(true);
  expect(latest.olderCursor).toBeNull();

  api.chats.transcript.mockResolvedValueOnce(page(["old-1"], { olderItemCursor: "old-0" }));
  await act(async () => {
    await latest.showEarlier();
  });
  expect(api.chats.transcript).toHaveBeenLastCalledWith({ botId: "bot-1", beforeReset: true });
  expect(latest.messages?.map((m) => m.id)).toEqual(["old-1", "new-1"]);
  expect(latest.canShowEarlier).toBe(false);
  expect(latest.olderCursor).toBe("old-0");

  api.chats.transcript.mockResolvedValueOnce(page(["old-0"]));
  await act(async () => {
    await latest.loadOlder();
  });
  expect(api.chats.transcript).toHaveBeenLastCalledWith({
    botId: "bot-1",
    before: "old-0",
    beforeReset: true,
  });

  // Another clear: nothing loaded survives; the Conversation is read afresh.
  api.chats.transcript.mockResolvedValueOnce(
    page([], { reset: { itemId: "r2", createdAt: "2026-10-03T11:00:00.000Z" } }),
  );
  await act(async () => {
    family.listener?.({ type: "chatReset", chatId: "conv", itemId: "r2" });
    await vi.advanceTimersByTimeAsync(200);
  });
  expect(latest.messages).toEqual([]);
  expect(latest.canShowEarlier).toBe(true);
});

it("reads again when the engine says how a message sent mid-turn was taken", async () => {
  api.chats.transcript.mockResolvedValueOnce(page(["a"]));
  await mountHook();
  expect(api.chats.transcript).toHaveBeenCalledTimes(1);

  api.chats.transcript.mockResolvedValueOnce(page(["a", "b"]));
  await act(async () => {
    family.listener?.({
      type: "messageDelivery",
      chatId: "conv",
      itemId: "b",
    });
    await vi.advanceTimersByTimeAsync(200);
  });
  expect(api.chats.transcript).toHaveBeenCalledTimes(2);
  expect(latest.messages?.map((m) => m.id)).toEqual(["a", "b"]);

  // Another chat's delivery is not this Conversation's business.
  await act(async () => {
    family.listener?.({
      type: "messageDelivery",
      chatId: "other",
      itemId: "x",
    });
    await vi.advanceTimersByTimeAsync(200);
  });
  expect(api.chats.transcript).toHaveBeenCalledTimes(2);
});

it("is running while the engine says a reply is being written, and idle after", async () => {
  api.chats.transcript.mockResolvedValueOnce(page(["a"], { running: true }));
  await mountHook();
  expect(latest.running).toBe(true);

  api.chats.transcript.mockResolvedValueOnce({
    ...page(["a"]),
    messages: [message("a"), message("b", "bot")],
  });
  await act(async () => {
    family.listener?.({ type: "turnDone", chatId: "conv", status: "completed" });
    await vi.advanceTimersByTimeAsync(200);
  });
  expect(latest.running).toBe(false);
});

it("shows a sent message at once and keeps the Conversation running until the reply is in", async () => {
  api.chats.transcript.mockResolvedValueOnce(page([]));
  await mountHook();
  expect(latest.running).toBe(false);

  await act(async () => latest.beginSend("hello"));
  expect(latest.pendingMessage?.blocks).toEqual([{ kind: "text", text: "hello" }]);
  expect(latest.running).toBe(true);

  // The engine has recorded the message but not started: the pending copy gives way, the row stays.
  api.chats.transcript.mockResolvedValueOnce(page(["m1"]));
  await act(async () => {
    family.listener?.({ type: "messageDelivery", chatId: "conv", itemId: "m1" });
    await vi.advanceTimersByTimeAsync(200);
  });
  expect(latest.pendingMessage).toBeNull();
  expect(latest.running).toBe(true);

  api.chats.transcript.mockResolvedValueOnce({
    ...page(["m1"]),
    messages: [message("m1"), message("m2", "bot")],
  });
  await act(async () => {
    family.listener?.({ type: "messageDone", chatId: "conv", itemId: "m2" });
    await vi.advanceTimersByTimeAsync(200);
  });
  expect(latest.running).toBe(false);
});

it("takes a message back when the send fails", async () => {
  api.chats.transcript.mockResolvedValueOnce(page(["a"]));
  await mountHook();
  await act(async () => latest.beginSend("hello"));
  await act(async () => latest.failSend());
  expect(latest.pendingMessage).toBeNull();
  expect(latest.running).toBe(false);
});

it("reads on a timer only while a reply is expected, whatever the stream does", async () => {
  api.chats.transcript.mockResolvedValue(page(["a"]));
  await mountHook();
  expect(api.chats.transcript).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20_000);
  });
  expect(api.chats.transcript).toHaveBeenCalledTimes(1);

  await act(async () => latest.beginSend("hello"));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_500);
  });
  expect(api.chats.transcript).toHaveBeenCalledTimes(2);
});

it("marks the Conversation read when a reply lands while it is in view", async () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  api.chats.transcript.mockResolvedValue(page(["a"]));
  await mountHook();
  expect(api.chats.markRead).toHaveBeenCalledWith({ botId: "bot-1" });
  api.chats.markRead.mockClear();
  await act(async () => {
    family.listener?.({ type: "messageDone", chatId: "conv", itemId: "b" });
    await vi.advanceTimersByTimeAsync(200);
  });
  expect(api.chats.markRead).toHaveBeenCalledTimes(1);

  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  api.chats.markRead.mockClear();
  await act(async () => {
    family.listener?.({ type: "messageDone", chatId: "conv", itemId: "c" });
    await vi.advanceTimersByTimeAsync(200);
  });
  expect(api.chats.markRead).not.toHaveBeenCalled();
});
