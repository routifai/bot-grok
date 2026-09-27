// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  feed: { list: vi.fn() },
  asks: { answer: vi.fn() },
  ideas: { list: vi.fn(), refresh: vi.fn() },
  topics: { list: vi.fn(), remove: vi.fn() },
}));
vi.mock("../../lib/rpc", () => ({ rpc: api }));
vi.mock("../../lib/relative-time", () => ({ formatRelativeTime: () => "just now" }));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray) => parts.join("");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/chat-ui/web", () => ({
  ChatMarkdown: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: (props: ComponentProps<"button">) => <button {...props} />,
  Input: (props: ComponentProps<"input">) => <input {...props} />,
}));

import type { Ask, FollowedTopic, Idea, Post } from "@rakazo/contracts";
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

function idea(overrides: Partial<Idea> = {}): Idea {
  return {
    id: "idea-1",
    text: "Quiz me on today's phrases",
    area: "learning",
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
  api.feed.list.mockResolvedValue({
    asks: [ask({ text: "Which evenings work?" })],
    posts: [post({ title: "Chose a course" })],
    nextCursor: null,
  });
  api.ideas.list.mockResolvedValue([]);
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
  api.feed.list.mockResolvedValue({
    asks: [ask({ id: "ask-9", runId: "run-9", choices: [{ id: "mon", label: "Monday" }] })],
    posts: [],
    nextCursor: null,
  });
  api.ideas.list.mockResolvedValue([]);
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

it("links a topic Post to its source URL", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.feed.list.mockResolvedValue({
    asks: [],
    posts: [
      post({
        kind: "topic",
        title: "Agents that keep working",
        goalId: null,
        sourceUrl: "https://example.com/agents",
      }),
    ],
    nextCursor: null,
  });
  api.ideas.list.mockResolvedValue([]);
  api.topics.list.mockResolvedValue([]);
  const page = await renderFeed();
  try {
    const link = page.container.querySelector("a[href='https://example.com/agents']");
    expect(link).toBeTruthy();
    expect(link?.getAttribute("target")).toBe("_blank");
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("tapping an Idea calls onSendIdea with its text", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.feed.list.mockResolvedValue({ asks: [], posts: [], nextCursor: null });
  api.ideas.list.mockResolvedValue([idea({ text: "Plan this Sunday's run" })]);
  api.topics.list.mockResolvedValue([]);
  const onSendIdea = vi.fn();
  const page = await renderFeed(onSendIdea);
  try {
    const button = [...page.container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === "Plan this Sunday's run",
    );
    expect(button).toBeTruthy();
    await act(async () => {
      button?.click();
    });
    expect(onSendIdea).toHaveBeenCalledWith("Plan this Sunday's run");
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("removing a topic calls topics.remove", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.feed.list.mockResolvedValue({ asks: [], posts: [], nextCursor: null });
  api.ideas.list.mockResolvedValue([]);
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
