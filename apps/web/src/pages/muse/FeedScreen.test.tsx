// @vitest-environment jsdom

import type { ComponentProps, ReactElement, ReactNode } from "react";
import { act, cloneElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("react-dom/client", async (orig) =>
  (await import("../../test/i18n")).withI18nRoot(await orig<typeof import("react-dom/client")>()),
);

const api = vi.hoisted(() => ({
  feed: { list: vi.fn() },
  asks: { list: vi.fn(), answer: vi.fn() },
  topics: { list: vi.fn(), remove: vi.fn(), follow: vi.fn() },
}));
vi.mock("../../lib/rpc", () => ({ rpc: api }));
vi.mock("../../lib/relative-time", () => ({ formatRelativeTime: () => "2h ago" }));
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
  BotAvatar: () => <div data-testid="bot-avatar" />,
  Button: ({
    render,
    children,
    ...props
  }: { render?: ReactElement; children?: ReactNode } & ComponentProps<"button">) =>
    render ? (
      cloneElement(render, undefined, children)
    ) : (
      <button type="button" {...props}>
        {children}
      </button>
    ),
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  Sheet: ({ open, children }: { open: boolean; children?: ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
  SheetContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SheetHeader: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
}));

import type { Ask, FollowedTopic, Post } from "@nova/contracts";
import { FeedScreen } from "./FeedScreen";

function ask(overrides: Partial<Ask> = {}): Ask {
  return {
    id: "ask-1",
    runId: "run-1",
    kind: "question",
    goalId: null,
    goalTitle: null,
    text: "Which evenings work?",
    choices: [{ id: "mon", label: "Monday" }],
    input: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function post(overrides: Partial<Post> = {}): Post {
  return {
    id: "post-1",
    kind: "goal_report",
    title: "Chose a course",
    body: "Picked Genki I.",
    goalId: "goal-1",
    sourceUrl: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function topic(overrides: Partial<FollowedTopic> = {}): FollowedTopic {
  return {
    id: "topic-1",
    topic: "AI agent news",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

async function renderFeed(onSendIdea: (text: string) => void = vi.fn()) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<FeedScreen botId="bot-1" onSendIdea={onSendIdea} />);
  });
  return {
    container,
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

it("renders pinned Asks above Posts", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.asks.list.mockResolvedValue([ask({ text: "Which evenings work?" })]);
  api.feed.list.mockResolvedValue({
    asks: [],
    posts: [post({ title: "Chose a course" })],
    nextCursor: null,
  });
  api.topics.list.mockResolvedValue([]);
  const page = await renderFeed();
  try {
    const askIndex = page.container.textContent?.indexOf("Which evenings work?") ?? -1;
    const postIndex = page.container.textContent?.indexOf("Chose a course") ?? -1;
    expect(askIndex).toBeGreaterThanOrEqual(0);
    expect(postIndex).toBeGreaterThan(askIndex);
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("answering an Ask calls asks.answer and removes it", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // The first load has the Ask; the refetch after answering doesn't.
  api.asks.list
    .mockResolvedValueOnce([
      ask({ id: "ask-9", runId: "run-9", choices: [{ id: "mon", label: "Monday" }] }),
    ])
    .mockResolvedValue([]);
  api.feed.list.mockResolvedValue({
    asks: [],
    posts: [],
    nextCursor: null,
  });
  api.topics.list.mockResolvedValue([]);
  api.asks.answer.mockResolvedValue({ ok: true });
  const page = await renderFeed();
  try {
    const button = [...page.container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === "Monday",
    );
    expect(button).toBeTruthy();
    await act(async () => {
      button?.click();
    });
    expect(api.asks.answer).toHaveBeenCalledWith({
      askId: "ask-9",
      runId: "run-9",
      answer: "mon",
    });
    expect(page.container.textContent).not.toContain("Which evenings work?");
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("shows a topic Post as a plain preview with domain sources, and opens the full text", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.asks.list.mockResolvedValue([]);
  api.feed.list.mockResolvedValue({
    asks: [],
    posts: [
      post({
        kind: "topic",
        title: "AI agent news",
        goalId: null,
        sourceUrl: null,
        body: "# Agent launches, Sept 28\n\nMost of this comes from **vendor blogs** and [Example News](https://www.example.com/agents).\n\n- Item one https://other.org/post\n",
      }),
    ],
    nextCursor: null,
  });
  api.topics.list.mockResolvedValue([]);
  const page = await renderFeed();
  try {
    const card = page.container.querySelector("button.text-start");
    expect(card?.textContent).toContain("Agent launches, Sept 28");
    expect(card?.textContent).toContain("AI agent news");
    expect(card?.textContent).toContain("Item one");
    // a leading source caveat is dropped from the preview, but its links still show as sources
    expect(card?.textContent).not.toContain("Most of this comes");
    expect(card?.textContent).not.toMatch(/[#*]|https?:/);
    const link = page.container.querySelector("a[href='https://www.example.com/agents']");
    expect(link?.textContent).toBe("example.com");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(page.container.querySelector("a[href='https://other.org/post']")).toBeTruthy();

    await act(async () => (card as HTMLButtonElement).click());
    expect(document.body.querySelector("[role='dialog']")?.textContent).toContain("vendor blogs");
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("removing a topic calls topics.remove", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.asks.list.mockResolvedValue([]);
  api.feed.list.mockResolvedValue({ asks: [], posts: [], nextCursor: null });
  api.topics.list.mockResolvedValue([topic({ id: "topic-7", topic: "Moroccan design" })]);
  api.topics.remove.mockResolvedValue({ ok: true });
  const page = await renderFeed();
  try {
    expect(page.container.textContent).toContain("Moroccan design");
    const button = [...page.container.querySelectorAll("button")].find((candidate) =>
      candidate.getAttribute("aria-label")?.startsWith("Stop following"),
    );
    expect(button).toBeTruthy();
    await act(async () => {
      button?.click();
    });
    expect(api.topics.remove).toHaveBeenCalledWith({ topicId: "topic-7" });
    expect(page.container.textContent).not.toContain("Moroccan design");
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("on an empty Feed, a suggested topic is followed in one tap", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.asks.list.mockResolvedValue([]);
  api.feed.list.mockResolvedValue({ asks: [], posts: [], nextCursor: null });
  api.topics.list.mockResolvedValue([]);
  api.topics.follow.mockResolvedValue({
    id: "topic-9",
    topic: "AI in banking",
    createdAt: new Date().toISOString(),
  });
  const page = await renderFeed(vi.fn());
  try {
    await act(async () => {
      await vi.waitFor(() => {
        expect(page.container.textContent).toContain("Topics I follow for you");
      });
    });
    const button = [...page.container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === "AI in banking",
    );
    expect(button).toBeTruthy();
    await act(async () => {
      button?.click();
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(page.container.textContent).toContain("Checked daily");
      });
    });
    expect(api.topics.follow).toHaveBeenCalledWith({ botId: "bot-1", topic: "AI in banking" });
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("labels a followed topic with its own cadence", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.asks.list.mockResolvedValue([]);
  api.feed.list.mockResolvedValue({ asks: [], posts: [], nextCursor: null });
  api.topics.list.mockResolvedValue([
    topic({ id: "t-w", topic: "AI agent launches", cadence: "weekly" }),
    topic({ id: "t-d", topic: "Mortgage rates" }),
  ]);
  const page = await renderFeed();
  try {
    expect(page.container.textContent).toContain("Checked weekly");
    expect(page.container.textContent).toContain("Checked daily");
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("hides the example Feed once a topic is followed, and shows it only when truly empty", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.asks.list.mockResolvedValue([]);
  api.feed.list.mockResolvedValue({ asks: [], posts: [], nextCursor: null });
  api.topics.list.mockResolvedValue([topic({ id: "topic-1", topic: "Moroccan design" })]);
  const followed = await renderFeed();
  try {
    expect(followed.container.textContent).toContain("Moroccan design");
    expect(followed.container.textContent).not.toContain("what a morning with me looks like");
  } finally {
    await followed.cleanup();
  }
  api.topics.list.mockResolvedValue([]);
  const empty = await renderFeed();
  try {
    expect(empty.container.textContent).toContain("what a morning with me looks like");
  } finally {
    await empty.cleanup();
    vi.unstubAllGlobals();
  }
});
