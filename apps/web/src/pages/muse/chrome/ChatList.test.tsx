// @vitest-environment jsdom

import type { ChatSummary } from "@aiden/contracts";
import { ORPCError } from "@orpc/client";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  chats: { list: vi.fn(), createSide: vi.fn() },
}));
vi.mock("../../../lib/rpc", () => ({ rpc: api }));
vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((acc, part, i) => `${acc}${part}${values[i] ?? ""}`, ""),
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((acc, part, i) => `${acc}${part}${values[i] ?? ""}`, "");
  return {
    useLingui: () => ({ t, i18n: { locale: "en" } }),
    Trans: ({ children }: { children: ReactNode }) => children,
  };
});
vi.mock("@aiden/ui-web", () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
  BotAvatar: () => null,
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
  TooltipContent: () => null,
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children, ...props }: { children: ReactNode }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" data-testid="menu-item" onClick={onClick}>
      {children}
    </button>
  ),
}));

import { ChatListSection } from "./MuseSidebar";
import { useChatList } from "./useChatList";

const chat = (overrides: Partial<ChatSummary>): ChatSummary => ({
  id: "chat-main",
  kind: "super",
  title: "Main chat",
  start: null,
  updatedAt: "2026-10-03T10:00:00.000Z",
  ...overrides,
});

function Harness({ onOpenChat }: { onOpenChat?: (id: string) => void }) {
  const list = useChatList("bot-1");
  return (
    <ChatListSection
      state={list.state}
      collapsed={false}
      conversationActive
      onOpenMain={() => undefined}
      onOpenChat={onOpenChat}
      onCreateSide={(start) => void list.createSide(start).then((c) => onOpenChat?.(c.id))}
    />
  );
}

async function mount(node: ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(node);
  });
  await act(async () => {});
  return host;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = "";
  api.chats.list.mockReset();
  api.chats.createSide.mockReset();
});

it("lists the Main chat and the Side Chats", async () => {
  api.chats.list.mockResolvedValue([
    chat({}),
    chat({ id: "side-1", kind: "side", title: "Check Q3 spreadsheet", start: "withContext" }),
  ]);
  const host = await mount(<Harness onOpenChat={() => undefined} />);
  const list = host.querySelector('[data-testid="chat-list"]');
  expect(list?.getAttribute("data-status")).toBe("ready");
  expect(host.textContent).toContain("Main chat");
  expect(host.textContent).toContain("Check Q3 spreadsheet");
  expect(api.chats.list).toHaveBeenCalledWith({ botId: "bot-1" });
});

it("shows Side chats as not available yet while the backend can't serve chats", async () => {
  api.chats.list.mockRejectedValue(new ORPCError("NOT_IMPLEMENTED"));
  const host = await mount(<Harness />);
  const list = host.querySelector('[data-testid="chat-list"]');
  expect(list?.getAttribute("data-status")).toBe("unavailable");
  expect(host.textContent).not.toContain("Main chat");
  const add = host.querySelector<HTMLButtonElement>('button[aria-label="New side chat"]');
  expect(add?.disabled).toBe(true);
  expect(add?.title).toBe("Not available yet");
});

it("creates a blank Side Chat, refreshes the list and opens it", async () => {
  api.chats.list.mockResolvedValue([chat({})]);
  api.chats.createSide.mockResolvedValue(
    chat({ id: "side-2", kind: "side", title: "New side chat", start: "blank" }),
  );
  const opened = vi.fn();
  const host = await mount(<Harness onOpenChat={opened} />);
  const blank = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="menu-item"]')].find(
    (b) => b.textContent === "Blank",
  );
  await act(async () => {
    blank?.click();
  });
  await act(async () => {});
  expect(api.chats.createSide).toHaveBeenCalledWith({ botId: "bot-1", start: "blank" });
  expect(api.chats.list).toHaveBeenCalledTimes(2);
  expect(opened).toHaveBeenCalledWith("side-2");
});
