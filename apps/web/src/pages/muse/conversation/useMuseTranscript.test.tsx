// @vitest-environment jsdom

import type { FamilyEvent, ThreadMessage, ThreadMessagePage } from "@nova/contracts";
import { act, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ chats: { transcript: vi.fn() } }));
const family = vi.hoisted(() => ({ listener: null as ((event: FamilyEvent) => void) | null }));
vi.mock("../../../lib/rpc", () => ({ rpc: api }));
vi.mock("../../../lib/family-stream", () => ({
  watchFamily: (_botId: string, listener: (event: FamilyEvent) => void) => {
    family.listener = listener;
    return () => undefined;
  },
}));

import { useMuseTranscript } from "./useMuseTranscript";

const message = (id: string): ThreadMessage => ({
  id,
  threadId: "conv",
  seq: 0,
  role: "user",
  blocks: [{ kind: "text", text: id }],
  createdAt: "2026-10-03T10:00:00.000Z",
});
const page = (ids: string[], extra: Partial<ThreadMessagePage> = {}): ThreadMessagePage => ({
  threadId: "conv",
  messages: ids.map(message),
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
