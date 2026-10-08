// @vitest-environment jsdom

import type { ChatSummary, FamilyEvent } from "@nova/contracts";
import { ORPCError } from "@orpc/client";
import type { ComponentProps, ReactNode } from "react";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("react-dom/client", async (orig) =>
  (await import("../../../test/i18n")).withI18nRoot(
    await orig<typeof import("react-dom/client")>(),
  ),
);

const api = vi.hoisted(() => ({
  chats: {
    list: vi.fn(),
    createSide: vi.fn(),
    summaryPreview: vi.fn(),
    transcript: vi.fn(),
    watch: vi.fn(),
    send: vi.fn(),
  },
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
vi.mock("@nova/chat-ui/web", () => ({
  ChatMarkdown: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@nova/ui-web", () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
  BotAvatar: () => null,
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children, ...props }: ComponentProps<"button">) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
  Button: (props: ComponentProps<"button">) => <button {...props} />,
  Spinner: () => <span data-testid="spinner" />,
  Popover: ({ children }: { children: ReactNode }) => children,
  PopoverTrigger: ({ children, ...props }: ComponentProps<"button">) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Switch: ({
    checked,
    onCheckedChange,
    ...props
  }: {
    checked?: boolean;
    onCheckedChange?: (value: boolean) => void;
  } & ComponentProps<"span">) => (
    // Like the real Switch: a click flips it via onCheckedChange and bubbles to its parent.
    <span
      data-testid="switch-knob"
      data-checked={checked}
      onClick={() => onCheckedChange?.(!checked)}
      {...props}
    />
  ),
  Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
}));

import { ChatTree } from "./MuseSidebar";
import { SideChatSession, type SideChatView, type SideChatWire } from "./SideChatSession";

/** Stands in for the Conversation's Transcript/Composer (Shell.tsx), which the session
 * receives as `view`. */
const fakeView: SideChatView = {
  Transcript: ({ messages, running, leading, trailing }) => (
    <div data-running={running}>
      {leading}
      {messages.map((message) => (
        <p key={message.id}>
          {message.blocks.map((block) => (block.kind === "text" ? block.text : "")).join("")}
        </p>
      ))}
      {trailing}
    </div>
  ),
  Composer: ({ placeholder, onSend }) => {
    const [value, setValue] = useState("");
    return (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void onSend(value);
        }}
      >
        <textarea
          placeholder={placeholder}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </form>
    );
  },
};

import { useChatList } from "./useChatList";

function chat(overrides: Partial<ChatSummary>): ChatSummary {
  return {
    id: "side-1",
    title: "Side chat",
    start: "withContext",
    summary: "A summary of the conversation",
    archived: false,
    live: false,
    updatedAt: "2026-10-03T10:00:00.000Z",
    ...overrides,
  };
}

const roots: Root[] = [];

/** A family stream the test pushes events into. */
function familyStream() {
  const queue: FamilyEvent[] = [];
  let wake: (() => void) | null = null;
  const iterable: AsyncIterable<FamilyEvent> = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (queue.length > 0) yield queue.shift() as FamilyEvent;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
  return {
    iterable,
    push(event: FamilyEvent) {
      queue.push(event);
      wake?.();
    },
  };
}

async function mount(node: ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(node);
  });
  await act(async () => {});
  return host;
}

function setInputValue(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = "";
  api.chats.list.mockReset();
  api.chats.createSide.mockReset();
  api.chats.summaryPreview.mockReset();
  api.chats.transcript.mockReset();
  api.chats.watch.mockReset();
  // Quiet by default: the stream opens and says nothing.
  api.chats.watch.mockImplementation(async () => familyStream().iterable);
  api.chats.send.mockReset();
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
});

it("extends the Chat List wire's createSide to carry the first message", async () => {
  api.chats.list.mockResolvedValue([]);
  api.chats.createSide.mockResolvedValue(chat({ id: "side-new", title: "New side chat" }));

  function Harness() {
    const list = useChatList("bot-1");
    return (
      <button type="button" onClick={() => void list.createSide("blank", "Check the backlog")}>
        create
      </button>
    );
  }
  const host = await mount(<Harness />);
  await act(async () => {
    host.querySelector("button")?.click();
  });
  await act(async () => {});
  expect(api.chats.createSide).toHaveBeenCalledWith({
    botId: "bot-1",
    start: "blank",
    text: "Check the backlog",
  });
  expect(api.chats.list).toHaveBeenCalledTimes(2);
});

it("shows nothing Side-Chat related while the chats wire answers NOT_IMPLEMENTED", async () => {
  api.chats.list.mockRejectedValue(new ORPCError("NOT_IMPLEMENTED"));
  function Harness() {
    const list = useChatList("bot-1");
    return (
      <ChatTree
        state={list.state}
        collapsed={false}
        activeChatId={null}
        onOpenChat={() => undefined}
        onNewDraft={() => undefined}
      />
    );
  }
  const host = await mount(<Harness />);
  expect(host.querySelector('[data-testid="chat-tree"]')).toBeNull();
  expect(host.textContent).toBe("");
  expect(host.innerHTML).toBe("");
});

it("lists Side Chats newest first, with a pulsing dot while Nova is working in one, and folds Archived behind a collapsed count", async () => {
  const onOpenChat = vi.fn();
  const host = await mount(
    <ChatTree
      state={{
        status: "ready",
        chats: [
          chat({ id: "older", title: "Older chat", updatedAt: "2026-10-01T00:00:00.000Z" }),
          chat({
            id: "newer",
            title: "Newer chat",
            live: true,
            updatedAt: "2026-10-03T00:00:00.000Z",
          }),
          chat({ id: "gone", title: "Old pricing copy", archived: true }),
        ],
      }}
      collapsed={false}
      activeChatId={null}
      onOpenChat={onOpenChat}
      onNewDraft={() => undefined}
    />,
  );
  const text = host.textContent ?? "";
  expect(text.indexOf("Newer chat")).toBeLessThan(text.indexOf("Older chat"));
  // The archived chat is folded away by default, behind a count.
  expect(text).not.toContain("Old pricing copy");
  expect(text).toContain("1");
  // Nova's pulsing dot (announced via sr-only text) only marks the live chat.
  const liveRow = [...host.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Nova is working"),
  );
  expect(liveRow?.textContent).toContain("Newer chat");
  expect(text).toContain("New side chat");

  const fold = [...host.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Archived"),
  );
  await act(async () => {
    fold?.click();
  });
  expect(host.textContent).toContain("Old pricing copy");

  const archivedRow = [...host.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Old pricing copy"),
  );
  archivedRow?.click();
  expect(onOpenChat).toHaveBeenCalledWith(expect.objectContaining({ id: "gone" }));
});

it("a Side Chat draft locks its start from the switch and calls createSide with { start, text }", async () => {
  const created = chat({ id: "side-9", title: "Check the backlog", start: "blank", summary: null });
  const wire: SideChatWire = {
    summaryPreview: vi.fn().mockResolvedValue({ summary: "A summary" }),
    createSide: vi.fn().mockResolvedValue(created),
    transcript: vi.fn().mockResolvedValue({ threadId: "t", messages: [], olderCursor: null }),
    send: vi.fn(),
  };
  const onCreated = vi.fn();
  const host = await mount(
    <SideChatSession
      bot={{ id: "bot-1", name: "Nova", color: "#000" }}
      view={fakeView}
      chat="draft"
      wire={wire}
      onCreated={onCreated}
      onClose={() => undefined}
    />,
  );
  expect(host.textContent).toContain("What do you want to look at?");

  // Default is on; switching it off locks the Side Chat to start blank.
  const knowsSwitch = host.querySelector<HTMLButtonElement>('[role="switch"]');
  expect(knowsSwitch?.getAttribute("aria-checked")).toBe("true");
  await act(async () => {
    knowsSwitch?.click();
  });
  expect(knowsSwitch?.getAttribute("aria-checked")).toBe("false");

  const textarea = host.querySelector<HTMLTextAreaElement>("textarea")!;
  await act(async () => {
    setInputValue(textarea, "Check the backlog");
  });
  const form = host.querySelector("form")!;
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await act(async () => {});

  expect(wire.createSide).toHaveBeenCalledWith({
    botId: "bot-1",
    start: "blank",
    text: "Check the backlog",
  });
  expect(onCreated).toHaveBeenCalledWith(created);
});

it("clicking the switch knob itself toggles 'Knows our conversation' exactly once", async () => {
  const wire: SideChatWire = {
    summaryPreview: vi.fn().mockResolvedValue({ summary: "A summary" }),
    createSide: vi.fn(),
    transcript: vi.fn(),
    send: vi.fn(),
  };
  const host = await mount(
    <SideChatSession
      bot={{ id: "bot-1", name: "Nova", color: "#000" }}
      view={fakeView}
      chat="draft"
      wire={wire}
      onCreated={() => undefined}
      onClose={() => undefined}
    />,
  );
  const pill = host.querySelector<HTMLButtonElement>('[role="switch"]');
  const knob = host.querySelector<HTMLElement>('[data-testid="switch-knob"]');
  expect(pill?.getAttribute("aria-checked")).toBe("true");
  await act(async () => {
    knob?.click();
  });
  expect(pill?.getAttribute("aria-checked")).toBe("false");
});

it("an archived Side Chat opens read-only: no composer, its messages still show", async () => {
  const archived = chat({
    id: "side-old",
    title: "Old pricing copy",
    archived: true,
    start: "blank",
    summary: null,
  });
  const wire: SideChatWire = {
    summaryPreview: vi.fn(),
    createSide: vi.fn(),
    transcript: vi.fn().mockResolvedValue({
      threadId: "side-old",
      messages: [
        {
          id: "m1",
          threadId: "side-old",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "Tighten the pricing headline." }],
          createdAt: "2026-09-01T00:00:00.000Z",
        },
      ],
      olderCursor: null,
    }),
    send: vi.fn(),
  };
  const host = await mount(
    <SideChatSession
      bot={{ id: "bot-1", name: "Nova", color: "#000" }}
      view={fakeView}
      chat={archived}
      wire={wire}
      onCreated={() => undefined}
      onClose={() => undefined}
    />,
  );
  await act(async () => {});
  expect(host.textContent).toContain("Archived");
  expect(host.textContent).toContain("Tighten the pricing headline.");
  expect(host.querySelector("textarea")).toBeNull();
  expect(host.querySelector("form")).toBeNull();
});

it("an archived Side Chat offers Restore; restoring makes it writable again", async () => {
  const wire: SideChatWire = {
    summaryPreview: vi.fn(),
    createSide: vi.fn(),
    transcript: vi
      .fn()
      .mockResolvedValue({ threadId: "side-old", messages: [], olderCursor: null }),
    send: vi.fn(),
    unarchive: vi.fn().mockResolvedValue({ ok: true }),
  };
  function Harness() {
    const [archived, setArchived] = useState(true);
    return (
      <SideChatSession
        bot={{ id: "bot-1", name: "Nova", color: "#000" }}
        view={fakeView}
        chat={chat({ id: "side-old", title: "Old pricing copy", archived })}
        wire={wire}
        onCreated={() => undefined}
        onClose={() => undefined}
        onRestored={() => setArchived(false)}
      />
    );
  }
  const host = await mount(<Harness />);
  await act(async () => {});
  expect(host.querySelector("textarea")).toBeNull();
  const restore = [...host.querySelectorAll("button")].find((b) => b.textContent === "Restore");
  expect(restore).toBeDefined();
  await act(async () => {
    restore?.click();
  });
  expect(wire.unarchive).toHaveBeenCalledWith({ botId: "bot-1", chatId: "side-old" });
  expect(host.textContent).not.toContain("Restore");
  expect(host.querySelector("textarea")).not.toBeNull();
});

it("an open Side Chat has no Restore", async () => {
  const wire: SideChatWire = {
    summaryPreview: vi.fn(),
    createSide: vi.fn(),
    transcript: vi.fn().mockResolvedValue({ threadId: "side-1", messages: [], olderCursor: null }),
    send: vi.fn(),
    unarchive: vi.fn(),
  };
  const host = await mount(
    <SideChatSession
      bot={{ id: "bot-1", name: "Nova", color: "#000" }}
      view={fakeView}
      chat={chat({ id: "side-1", archived: false })}
      wire={wire}
      onCreated={() => undefined}
      onClose={() => undefined}
    />,
  );
  await act(async () => {});
  expect(host.textContent).not.toContain("Restore");
});

it("a failed Side Chat send is retried once, then shows a calm note with a Retry that resends", async () => {
  vi.useFakeTimers();
  try {
    const send = vi.fn().mockRejectedValue(new Error("down"));
    const wire: SideChatWire = {
      summaryPreview: vi.fn(),
      createSide: vi.fn(),
      transcript: vi
        .fn()
        .mockResolvedValue({ threadId: "side-1", messages: [], olderCursor: null }),
      send,
    };
    const host = await mount(
      <SideChatSession
        bot={{ id: "bot-1", name: "Nova", color: "#000" }}
        view={fakeView}
        chat={chat({ id: "side-1" })}
        wire={wire}
        onCreated={() => undefined}
        onClose={() => undefined}
      />,
    );
    const textarea = host.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => {
      setInputValue(textarea, "ping");
    });
    await act(async () => {
      host
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    // The message stays put, the working state shows, and the first failure reads as a retry.
    expect(host.textContent).toContain("ping");
    expect(host.textContent).toContain("Retrying");
    expect(host.querySelector('[data-running="true"]')).not.toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain("Didn’t send. Try again");
    expect(host.querySelector('[data-running="false"]')).not.toBeNull();

    send.mockResolvedValue({ ok: true });
    const retry = [...host.querySelectorAll("button")].find((b) => b.textContent === "Retry");
    await act(async () => {
      retry?.click();
    });
    expect(send).toHaveBeenLastCalledWith({ chatId: "side-1", text: "ping" });
    expect(host.textContent).not.toContain("Didn’t send");
  } finally {
    vi.useRealTimers();
  }
});

it("a failed Side Chat draft keeps the message and offers Retry", async () => {
  const createSide = vi.fn().mockRejectedValue(new Error("down"));
  const wire: SideChatWire = {
    summaryPreview: vi.fn().mockResolvedValue({ summary: "" }),
    createSide,
    transcript: vi.fn(),
    send: vi.fn(),
  };
  const host = await mount(
    <SideChatSession
      bot={{ id: "bot-1", name: "Nova", color: "#000" }}
      view={fakeView}
      chat="draft"
      wire={wire}
      onCreated={() => undefined}
      onClose={() => undefined}
    />,
  );
  await act(async () => {
    setInputValue(host.querySelector<HTMLTextAreaElement>("textarea")!, "hello");
  });
  await act(async () => {
    host
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await act(async () => {});
  expect(host.textContent).toContain("hello");
  expect(host.textContent).toContain("Didn’t send. Try again");
});

it("the Chat List reads again when the engine says a chat changed or a reply landed, without polling", async () => {
  vi.useFakeTimers();
  try {
    const stream = familyStream();
    api.chats.watch.mockImplementation(async () => stream.iterable);
    api.chats.list.mockResolvedValue([]);
    function Harness() {
      useChatList("bot-1");
      return null;
    }
    await mount(<Harness />);
    expect(api.chats.list).toHaveBeenCalledTimes(1);

    // A quiet minute is not a reason to read again.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(api.chats.list).toHaveBeenCalledTimes(1);

    stream.push({ type: "chatsChanged" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(api.chats.list).toHaveBeenCalledTimes(2);

    stream.push({ type: "messageDone", chatId: "side-1", itemId: "i1" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(api.chats.list).toHaveBeenCalledTimes(3);
  } finally {
    vi.useRealTimers();
  }
});

it("a Side Chat reads its transcript again when its own reply lands, and not on a timer", async () => {
  vi.useFakeTimers();
  try {
    const stream = familyStream();
    api.chats.watch.mockImplementation(async () => stream.iterable);
    const reply = {
      id: "m2",
      threadId: "side-1",
      seq: 1,
      role: "bot" as const,
      blocks: [{ kind: "text" as const, text: "Here is the answer." }],
      createdAt: "2026-10-03T10:00:00.000Z",
    };
    const transcript = vi
      .fn()
      .mockResolvedValueOnce({ threadId: "side-1", messages: [], olderCursor: null })
      .mockResolvedValue({ threadId: "side-1", messages: [reply], olderCursor: null });
    const wire: SideChatWire = {
      summaryPreview: vi.fn(),
      createSide: vi.fn(),
      transcript,
      watch: (botId, listener) => {
        void (async () => {
          for await (const event of await api.chats.watch({ botId })) listener(event);
        })();
        return () => undefined;
      },
      send: vi.fn(),
    };
    const host = await mount(
      <SideChatSession
        bot={{ id: "bot-1", name: "Nova", color: "#000" }}
        view={fakeView}
        chat={chat({ id: "side-1" })}
        wire={wire}
        onCreated={() => undefined}
        onClose={() => undefined}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    const quiet = transcript.mock.calls.length;
    expect(host.textContent).not.toContain("Here is the answer.");

    // Another chat's reply is not this chat's business.
    stream.push({ type: "messageDone", chatId: "side-2", itemId: "x" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(transcript).toHaveBeenCalledTimes(quiet);

    stream.push({ type: "messageDone", chatId: "side-1", itemId: "m2" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(host.textContent).toContain("Here is the answer.");
  } finally {
    vi.useRealTimers();
  }
});

it("marks an unread Side Chat with a dot, except the one that is open", async () => {
  const chats = [
    chat({ id: "a", title: "Unseen chat", unread: true }),
    chat({ id: "b", title: "Open chat", unread: true }),
    chat({ id: "c", title: "Read chat", unread: false }),
  ];
  const host = await mount(
    <ChatTree
      state={{ status: "ready", chats }}
      collapsed={false}
      activeChatId="b"
      onOpenChat={() => undefined}
      onNewDraft={() => undefined}
    />,
  );
  const unreadRows = [...host.querySelectorAll("button")].filter((b) =>
    b.textContent?.includes("Unread"),
  );
  expect(unreadRows.map((row) => row.textContent)).toEqual(["Unseen chatUnread"]);
});

it("shows a loading state until a Side Chat's first page arrives", async () => {
  let release: (page: unknown) => void = () => undefined;
  const wire: SideChatWire = {
    summaryPreview: vi.fn(),
    createSide: vi.fn(),
    transcript: vi.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    ) as unknown as SideChatWire["transcript"],
    send: vi.fn(),
  };
  const host = await mount(
    <SideChatSession
      bot={{ id: "bot-1", name: "Nova", color: "#000" }}
      view={fakeView}
      chat={chat({})}
      wire={wire}
      onCreated={() => undefined}
      onClose={() => undefined}
    />,
  );
  expect(host.querySelector('[data-testid="side-chat-loading"]')).not.toBeNull();
  await act(async () => {
    release({ threadId: "side-1", messages: [], olderCursor: null });
  });
  expect(host.querySelector('[data-testid="side-chat-loading"]')).toBeNull();
});

it("reads an unread Side Chat when it is opened in view", async () => {
  const markRead = vi.fn().mockResolvedValue({ ok: true });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const wire: SideChatWire = {
    summaryPreview: vi.fn(),
    createSide: vi.fn(),
    transcript: vi.fn().mockResolvedValue({ threadId: "side-1", messages: [], olderCursor: null }),
    send: vi.fn(),
    markRead,
  };
  await mount(
    <SideChatSession
      bot={{ id: "bot-1", name: "Nova", color: "#000" }}
      view={fakeView}
      chat={chat({ unread: true })}
      wire={wire}
      onCreated={() => undefined}
      onClose={() => undefined}
    />,
  );
  expect(markRead).toHaveBeenCalledWith({ botId: "bot-1", chatId: "side-1" });
});

it("opens the chat the engine created when its first message did not send, ready to resend", async () => {
  const created = chat({
    id: "side-9",
    title: "Check the backlog",
    firstMessageErrorCode: "runner_unavailable",
  });
  const send = vi.fn().mockResolvedValue({ ok: true });
  const wire: SideChatWire = {
    summaryPreview: vi.fn().mockResolvedValue({ summary: "" }),
    createSide: vi.fn().mockResolvedValue(created),
    transcript: vi.fn().mockResolvedValue({ threadId: "side-9", messages: [], olderCursor: null }),
    send,
  };
  function Harness() {
    const [current, setCurrent] = useState<ChatSummary | "draft">("draft");
    return (
      <SideChatSession
        bot={{ id: "bot-1", name: "Nova", color: "#000" }}
        view={fakeView}
        chat={current}
        wire={wire}
        onCreated={setCurrent}
        onClose={() => undefined}
      />
    );
  }
  const host = await mount(<Harness />);
  await act(async () => {
    setInputValue(host.querySelector<HTMLTextAreaElement>("textarea")!, "Check the backlog");
  });
  await act(async () => {
    host
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await act(async () => {});
  await act(async () => {});
  expect(host.querySelector('[data-testid="side-chat-send-note"]')?.textContent).toContain(
    "Didn’t send",
  );
  const retry = [...host.querySelectorAll("button")].find((b) => b.textContent === "Retry");
  await act(async () => {
    retry?.click();
  });
  expect(send).toHaveBeenCalledWith({ chatId: "side-9", text: "Check the backlog" });
});
