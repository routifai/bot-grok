// @vitest-environment jsdom

import type { ChatSummary, ThreadMessage } from "@superchat/contracts";
import type { ReactNode } from "react";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("react-dom/client", async (orig) =>
  (await import("../../test/i18n")).withI18nRoot(await orig<typeof import("react-dom/client")>()),
);

import { SideChatSession, type SideChatView, type SideChatWire } from "./SideChatSession";
import { useForkView } from "./useForkView";

const view: SideChatView = {
  Transcript: () => <div />,
  Composer: () => <div />,
};
const wire: SideChatWire = {
  summaryPreview: vi.fn(),
  createSide: vi.fn(),
  transcript: vi.fn().mockResolvedValue({ threadId: "t", messages: [], olderCursor: null }),
  send: vi.fn(),
};

const chat = (overrides: Partial<ChatSummary> = {}): ChatSummary => ({
  id: "fork-1",
  title: "Why oolong?",
  start: "withContext",
  summary: null,
  archived: false,
  live: false,
  updatedAt: "2026-10-03T10:00:00.000Z",
  ...overrides,
});

const roots: Root[] = [];
async function mount(node: ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(node));
  await act(async () => {});
  return host;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = "";
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
});

it("a side chat that started as a fork offers 'Show as fork'; a plain one does not", async () => {
  const onShowAsFork = vi.fn();
  const fork = chat({ anchorItemId: "msg-3" });
  const host = await mount(
    <SideChatSession
      bot={{ id: "bot-1", name: "Superchat", color: "#000" }}
      view={view}
      chat={fork}
      wire={wire}
      onCreated={() => undefined}
      onClose={() => undefined}
      onShowAsFork={onShowAsFork}
    />,
  );
  const button = host.querySelector<HTMLButtonElement>("[data-testid=show-as-fork]");
  expect(button?.textContent).toBe("Show as fork");
  await act(async () => button?.click());
  expect(onShowAsFork).toHaveBeenCalledWith(fork);

  const plain = await mount(
    <SideChatSession
      bot={{ id: "bot-1", name: "Superchat", color: "#000" }}
      view={view}
      chat={chat({ id: "side-2" })}
      wire={wire}
      onCreated={() => undefined}
      onClose={() => undefined}
      onShowAsFork={onShowAsFork}
    />,
  );
  expect(plain.querySelector("[data-testid=show-as-fork]")).toBeNull();
});

it("'Show as fork' opens the fork's thread over its message and scrolls there", async () => {
  const anchor = { id: "msg-3", role: "assistant", blocks: [] } as unknown as ThreadMessage;
  const scrollToMessage = vi.fn();
  const box: { forks: ReturnType<typeof useForkView> | null } = { forks: null };
  function Probe({ messages }: { messages: ThreadMessage[] }) {
    box.forks = useForkView({
      chatList: { status: "ready", chats: [] } as never,
      messages,
      scrollRef: createRef<HTMLElement>(),
      reveal: async () => true,
      scrollToMessage,
    });
    return null;
  }
  await mount(<Probe messages={[anchor]} />);
  await act(async () => box.forks?.openChat(chat({ anchorItemId: "msg-3", unread: true })));
  expect(box.forks?.thread).toEqual({
    chat: { id: "fork-1", title: "Why oolong?", live: false, unread: true, archived: false },
    anchor,
  });
  expect(scrollToMessage).toHaveBeenCalledWith("msg-3");

  // An anchor not loaded yet: the thread opens and finds it itself (the reveal path).
  scrollToMessage.mockClear();
  await act(async () => box.forks?.openChat(chat({ anchorItemId: "msg-older" })));
  expect(box.forks?.thread?.anchor).toBeNull();
  expect(scrollToMessage).not.toHaveBeenCalled();
});
