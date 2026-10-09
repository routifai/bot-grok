// @vitest-environment jsdom

import type { ChatSummary, MessageFork, ThreadMessage, ThreadMessagePage } from "@nova/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("react-dom/client", async (orig) =>
  (await import("../../test/i18n")).withI18nRoot(await orig<typeof import("react-dom/client")>()),
);

const { template } = vi.hoisted(() => ({
  template: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((acc, part, i) => `${acc}${part}${values[i] ?? ""}`, ""),
}));
vi.mock("@lingui/core/macro", () => ({
  t: template,
  plural: (count: number, forms: { one: string; other: string }) =>
    (count === 1 ? forms.one : forms.other).replace("#", String(count)),
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: template, i18n: { locale: "en" } }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@nova/chat-ui/web", () => ({
  ChatMarkdown: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@nova/ui-web", () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
  Button: (props: ComponentProps<"button">) => <button {...props} />,
  Spinner: () => <span data-testid="spinner" />,
  Popover: ({ children }: { children: ReactNode }) => children,
  PopoverTrigger: ({ children, ...props }: ComponentProps<"button">) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  PopoverContent: ({ children }: { children: ReactNode }) => (
    <div data-testid="fork-fan">{children}</div>
  ),
}));
vi.mock("../../components/cards/context", () => ({
  ReplyCardBotProvider: ({ children }: { children: ReactNode }) => children,
  ReplyCardThreadProvider: ({ children }: { children: ReactNode }) => children,
  ReplyCardSendProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../pages/muse/conversation/MessageView", () => ({
  MessageView: ({ message }: { message: ThreadMessage }) => (
    <p>{message.blocks.map((block) => (block.kind === "text" ? block.text : "")).join("")}</p>
  ),
}));
vi.mock("../../pages/muse/conversation/MessageHoverActions", () => ({
  MessageHoverActions: () => null,
}));

import { AllForks } from "./AllForks";
import { ForkAsk } from "./ForkAsk";
import type { ForkWire } from "./ForkOverlay";
import { ForkThread } from "./ForkThread";
import { ForkUnderMessage } from "./ForkUnderMessage";
import type { ForkRow } from "./forkModel";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

const render = (node: ReactNode) => act(() => root.render(node));
const flush = () => act(async () => undefined);
const buttonNamed = (text: string) =>
  [...host.querySelectorAll("button")].find((button) => button.textContent?.includes(text));

function fork(overrides: Partial<MessageFork> = {}): MessageFork {
  return {
    chatId: "fork-a",
    title: "Which four banks?",
    replies: 1,
    live: false,
    unread: false,
    state: "open",
    summary: null,
    createdAt: "2026-10-07T09:40:00.000Z",
    ...overrides,
  };
}

function message(overrides: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id: "m1",
    threadId: "conv",
    seq: 0,
    role: "bot",
    blocks: [{ kind: "text", text: "I'm pulling public rate sheets for the four banks now." }],
    createdAt: "2026-10-07T09:39:00.000Z",
    forks: [],
    ...overrides,
  };
}

function page(messages: ThreadMessage[], lineage?: ThreadMessagePage["lineage"]) {
  return { threadId: "fork-a", messages, olderCursor: null, running: false, lineage };
}

function wire(overrides: Partial<ForkWire> = {}): ForkWire {
  return {
    summaryPreview: vi.fn(async () => ({ summary: "" })),
    createSide: vi.fn(),
    transcript: vi.fn(async () => page([])),
    send: vi.fn(async () => ({ ok: true as const })),
    createFork: vi.fn(),
    addToConversation: vi.fn(async () => ({ summary: "The same four as Q2" })),
    archive: vi.fn(async () => ({ ok: true as const })),
    ...overrides,
  };
}

it("draws one fork as a reply line, with its replies and a live dot while Nova works", () => {
  const onOpenFork = vi.fn();
  render(
    <ForkUnderMessage
      message={message({ forks: [fork({ live: true })] })}
      onOpenFork={onOpenFork}
    />,
  );
  const stub = host.querySelector<HTMLButtonElement>('[data-testid="fork-stub"]');
  expect(stub?.textContent).toContain("Which four banks?");
  expect(stub?.textContent).toContain("1 reply");
  expect(stub?.textContent).toContain("Nova is working");
  expect(host.querySelector('[data-testid="fork-pill"]')).toBeNull();
  act(() => stub?.click());
  expect(onOpenFork).toHaveBeenCalledWith(
    expect.objectContaining({ chatId: "fork-a" }),
    expect.anything(),
  );
});

it("draws several forks as one pill that fans out into a list and a new fork", () => {
  const onOpenFork = vi.fn();
  const onNewFork = vi.fn();
  const forks = [
    fork({ chatId: "a", title: "6.6% and margin", replies: 3 }),
    fork({ chatId: "b", title: "Show the math", replies: 2 }),
    fork({ chatId: "c", title: "Rate history", state: "added", replies: 1 }),
    fork({ chatId: "d", title: "Branch feedback", state: "archived" }),
    fork({ chatId: "e", title: "Q4 outlook" }),
  ];
  render(
    <ForkUnderMessage message={message({ forks })} onOpenFork={onOpenFork} onNewFork={onNewFork} />,
  );
  expect(host.querySelector('[data-testid="fork-stub"]')).toBeNull();
  const pill = host.querySelector('[data-testid="fork-pill"]');
  // The archived fork is not counted, drawn or listed.
  expect(pill?.textContent).toContain("4 forks");
  expect(pill?.textContent).toContain("3 open");
  expect(pill?.textContent).toContain("+1");
  expect(pill?.querySelectorAll("i")).toHaveLength(3);

  expect(buttonNamed("Branch feedback")).toBeUndefined();
  act(() => buttonNamed("Show the math")?.click());
  expect(onOpenFork).toHaveBeenCalledWith(
    expect.objectContaining({ chatId: "b" }),
    expect.anything(),
  );
  act(() => buttonNamed("New fork from this message")?.click());
  expect(onNewFork).toHaveBeenCalledWith(expect.objectContaining({ id: "m1" }));
});

it("shows an added fork's summary under its anchor, and opens that fork from it", () => {
  const onOpenFork = vi.fn();
  render(
    <ForkUnderMessage
      message={message({
        blocks: [
          { kind: "text", text: "Draft 2 is ready." },
          {
            kind: "fork_summary",
            forkId: "fork-a",
            anchorItemId: "m1",
            title: "Slide 7",
            summary: "Slide 7 becomes a bar chart by segment",
          },
        ],
        forks: [fork({ state: "added", summary: "Slide 7 becomes a bar chart by segment" })],
      })}
      onOpenFork={onOpenFork}
    />,
  );
  const line = host.querySelector<HTMLButtonElement>('[data-testid="fork-summary"]');
  expect(line?.textContent).toBe("From a fork: Slide 7 becomes a bar chart by segment");
  act(() => line?.click());
  expect(onOpenFork).toHaveBeenCalledTimes(1);
});

it("lift and ask opens a fork anchored at the message, with the question as its first message", async () => {
  const created: ChatSummary = {
    id: "fork-new",
    title: "Which four banks?",
    start: "withContext",
    summary: null,
    archived: false,
    live: true,
    unread: false,
    anchorItemId: "m1",
    updatedAt: "2026-10-07T09:40:00.000Z",
  };
  const forkWire = wire({ createFork: vi.fn(async () => created) });
  const onCreated = vi.fn();
  render(
    <ForkAsk
      botId="bot-1"
      wire={forkWire}
      anchor={message()}
      chatId={null}
      onClose={vi.fn()}
      onCreated={onCreated}
      onOpenSideChat={vi.fn()}
    />,
  );
  expect(host.querySelector('[data-testid="fork-origin"]')?.textContent).toContain("rate sheets");
  const field = host.querySelector("textarea");
  if (!field) throw new Error("no question box");
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setValue?.call(field, "Which four banks?");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    host.querySelector("form")?.requestSubmit();
  });
  expect(forkWire.createFork).toHaveBeenCalledWith({
    botId: "bot-1",
    anchorItemId: "m1",
    text: "Which four banks?",
  });
  expect(onCreated).toHaveBeenCalledWith(created, "Which four banks?");
});

it("offers a plain side chat when the fork would be too deep", async () => {
  const side = { id: "side-1" } as ChatSummary;
  const forkWire = wire({
    createFork: vi.fn(async () => {
      throw Object.assign(new Error("too deep"), { code: "FORK_TOO_DEEP" });
    }),
    createSide: vi.fn(async () => side),
  });
  const onOpenSideChat = vi.fn();
  render(
    <ForkAsk
      botId="bot-1"
      wire={forkWire}
      anchor={message({ id: "m9" })}
      chatId="fork-2"
      onClose={vi.fn()}
      onCreated={vi.fn()}
      onOpenSideChat={onOpenSideChat}
    />,
  );
  const field = host.querySelector("textarea");
  if (!field) throw new Error("no question box");
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setValue?.call(field, "And the cap?");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    host.querySelector("form")?.requestSubmit();
  });
  expect(forkWire.createFork).toHaveBeenCalledWith(
    expect.objectContaining({ chatId: "fork-2", anchorItemId: "m9" }),
  );
  await act(async () => buttonNamed("Open as side chat")?.click());
  expect(forkWire.createSide).toHaveBeenCalledWith({
    botId: "bot-1",
    start: "withContext",
    text: "And the cap?",
  });
  expect(onOpenSideChat).toHaveBeenCalledWith(side);
});

it("says so when the message can't be forked, instead of Didn't send", async () => {
  const forkWire = wire({
    createFork: vi.fn(async () => {
      throw Object.assign(new Error("no"), { code: "FORK_ANCHOR_INVALID" });
    }),
  });
  render(
    <ForkAsk
      botId="bot-1"
      wire={forkWire}
      anchor={message({ id: "m9" })}
      chatId={null}
      onClose={vi.fn()}
      onCreated={vi.fn()}
      onOpenSideChat={vi.fn()}
    />,
  );
  const field = host.querySelector("textarea");
  if (!field) throw new Error("no question box");
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setValue?.call(field, "how?");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    host.querySelector("form")?.requestSubmit();
  });
  expect(host.textContent).toContain("can’t be forked");
  expect(host.textContent).not.toContain("Didn’t send");
});

it("the thread view adds the fork back to the Conversation and returns to its anchor", async () => {
  const anchor = message({ forks: [fork()] });
  const forkWire = wire({
    transcript: vi.fn(async () =>
      page(
        [
          message({ id: "r1", role: "user", blocks: [{ kind: "text", text: "Which four?" }] }),
          message({ id: "r2", blocks: [{ kind: "text", text: "The same four as Q2." }] }),
        ],
        { rootId: "conv", parentId: "conv", anchorItemId: "m1" },
      ),
    ),
  });
  const onAdded = vi.fn();
  render(
    <ForkThread
      bot={{ id: "bot-1", name: "Nova", color: "sky" }}
      wire={forkWire}
      target={{
        chat: {
          id: "fork-a",
          title: "Which four banks?",
          live: false,
          unread: false,
          archived: false,
        },
        anchor,
      }}
      conversationId="conv"
      conversationMessages={[anchor]}
      onClose={vi.fn()}
      onOpenFork={vi.fn()}
      onAsk={vi.fn()}
      onOpenSideChat={vi.fn()}
      onAdded={onAdded}
      onArchived={vi.fn()}
    />,
  );
  await flush();
  expect(forkWire.transcript).toHaveBeenCalledWith({ botId: "bot-1", chatId: "fork-a" });
  expect(host.querySelector('[data-testid="fork-thread"]')?.textContent).toContain(
    "The same four as Q2.",
  );
  await act(async () => buttonNamed("Add to Conversation")?.click());
  expect(forkWire.addToConversation).toHaveBeenCalledWith({ botId: "bot-1", chatId: "fork-a" });
  expect(onAdded).toHaveBeenCalledWith("m1");
});

it("the thread view of an added fork offers no second add, only a side chat and archive", async () => {
  const anchor = message({ forks: [fork({ state: "added", summary: "Same four" })] });
  render(
    <ForkThread
      bot={{ id: "bot-1", name: "Nova", color: "sky" }}
      wire={wire()}
      target={{
        chat: {
          id: "fork-a",
          title: "Which four banks?",
          live: false,
          unread: false,
          archived: false,
        },
        anchor,
      }}
      conversationId="conv"
      conversationMessages={[anchor]}
      onClose={vi.fn()}
      onOpenFork={vi.fn()}
      onAsk={vi.fn()}
      onOpenSideChat={vi.fn()}
      onAdded={vi.fn()}
      onArchived={vi.fn()}
    />,
  );
  await flush();
  expect(buttonNamed("Add to Conversation")).toBeUndefined();
  expect(buttonNamed("Open as side chat")).toBeDefined();
  expect(buttonNamed("Archive")).toBeDefined();
  expect(host.textContent).toContain("Added to Conversation");
});

function renderThread(
  target: ComponentProps<typeof ForkThread>["target"],
  forkWire = wire(),
  extra: Partial<ComponentProps<typeof ForkThread>> = {},
) {
  render(
    <ForkThread
      bot={{ id: "bot-1", name: "Nova", color: "sky" }}
      wire={forkWire}
      target={target}
      conversationId="conv"
      conversationMessages={target.anchor ? [target.anchor] : []}
      onClose={vi.fn()}
      onOpenFork={vi.fn()}
      onAsk={vi.fn()}
      onOpenSideChat={vi.fn()}
      onAdded={vi.fn()}
      onArchived={vi.fn()}
      {...extra}
    />,
  );
}

const openChat = { id: "fork-a", title: "Which four banks?", live: false, unread: false };

it("a fork just opened shows its question and Nova working before the engine records it", async () => {
  // The engine sends the first message once the fork's context is ready: until then the
  // transcript is empty and not running.
  renderThread({
    chat: { ...openChat, live: true, archived: false },
    anchor: message({ forks: [fork()] }),
    firstText: "Which four banks?",
  });
  await flush();
  const thread = host.querySelector('[data-testid="fork-thread"]');
  expect(thread?.textContent).toContain("Which four banks?");
  expect(host.querySelector('[data-testid="fork-working"]')).not.toBeNull();
});

it("the thread view's sibling pills leave archived forks out", async () => {
  const anchor = message({
    forks: [
      fork({ chatId: "fork-a" }),
      fork({ chatId: "old", title: "Old test fork", state: "archived" }),
      fork({ chatId: "b", title: "Show the math" }),
    ],
  });
  renderThread({ chat: { ...openChat, archived: false }, anchor });
  await flush();
  expect(buttonNamed("Show the math")).toBeDefined();
  expect(buttonNamed("Old test fork")).toBeUndefined();
});

it("an archived fork's thread view offers Restore, not Archive, and restoring calls the wire", async () => {
  const forkWire = wire({ unarchive: vi.fn(async () => ({ ok: true as const })) });
  const onRestored = vi.fn();
  renderThread(
    {
      chat: { ...openChat, archived: true },
      anchor: message({ forks: [fork({ state: "archived" })] }),
    },
    forkWire,
    { onRestored },
  );
  await flush();
  expect(buttonNamed("Archive")).toBeUndefined();
  await act(async () => buttonNamed("Restore")?.click());
  expect(forkWire.unarchive).toHaveBeenCalledWith({ botId: "bot-1", chatId: "fork-a" });
  expect(onRestored).toHaveBeenCalledTimes(1);
});

it("an open fork's thread view has no Restore", async () => {
  renderThread(
    { chat: { ...openChat, archived: false }, anchor: message({ forks: [fork()] }) },
    wire({ unarchive: vi.fn() }),
  );
  await flush();
  expect(buttonNamed("Restore")).toBeUndefined();
  expect(buttonNamed("Archive")).toBeDefined();
});

function forkRow(overrides: Partial<ForkRow> = {}): ForkRow {
  return {
    chat: {
      id: "fork-a",
      title: "Which four banks?",
      start: "withContext",
      summary: null,
      archived: false,
      live: false,
      unread: false,
      updatedAt: "2026-10-07T09:40:00.000Z",
    },
    chatId: "fork-a",
    title: "Which four banks?",
    status: "open",
    tone: 1,
    anchorItemId: "m1",
    anchorText: null,
    replies: 1,
    project: null,
    unread: false,
    updatedAt: "2026-10-07T09:40:00.000Z",
    ...overrides,
  };
}

it("All forks restores an archived fork from its row without opening it", async () => {
  const onOpen = vi.fn();
  const onRestore = vi.fn(async () => undefined);
  const archived = forkRow({ chatId: "old", title: "Old test fork", status: "archived" });
  render(
    <AllForks
      rows={[forkRow(), archived]}
      filter="all"
      onFilter={vi.fn()}
      onOpen={onOpen}
      onRestore={onRestore}
      now={new Date("2026-10-07T10:00:00.000Z")}
    />,
  );
  const restoreButtons = [...host.querySelectorAll("button")].filter(
    (button) => button.textContent === "Restore",
  );
  // Only the archived row has one.
  expect(restoreButtons).toHaveLength(1);
  await act(async () => restoreButtons[0]?.click());
  expect(onRestore).toHaveBeenCalledWith(archived);
  expect(onOpen).not.toHaveBeenCalled();
});
