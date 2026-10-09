// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("react-dom/client", async (orig) =>
  (await import("../../test/i18n")).withI18nRoot(await orig<typeof import("react-dom/client")>()),
);

const api = vi.hoisted(() => ({
  ideas: { list: vi.fn(), refresh: vi.fn(), accept: vi.fn(), dismiss: vi.fn() },
}));
vi.mock("../../lib/rpc", () => ({ rpc: api }));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((acc, part, i) => `${acc}${part}${values[i] ?? ""}`, "");
  return {
    useLingui: () => ({ t, i18n: { locale: "en" } }),
    Trans: ({ children }: { children: ReactNode }) => children,
  };
});
vi.mock("@nova/ui-web", () => ({
  Button: (props: ComponentProps<"button">) => <button type="button" {...props} />,
  Skeleton: (props: ComponentProps<"div">) => <div {...props} />,
  BotAvatar: () => <div data-testid="bot-avatar" />,
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
}));

import type { Idea } from "@nova/contracts";
import { IdeasScreen } from "./IdeasScreen";

function idea(overrides: Partial<Idea> = {}): Idea {
  return {
    id: "idea-1",
    text: "Quiz me on today's phrases",
    area: "learning",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

async function renderIdeas(onSendIdea: (text: string) => void = vi.fn()) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<IdeasScreen botId="bot-1" onSendIdea={onSendIdea} />);
  });
  return {
    container,
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

it("groups Ideas by area under a sentence-case heading", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.ideas.list.mockResolvedValue([
    idea({ id: "idea-1", text: "Quiz me on today's phrases", area: "learning" }),
    idea({ id: "idea-2", text: "Draft this week's client note", area: "clients" }),
  ]);
  const page = await renderIdeas();
  try {
    await act(async () => {
      await vi.waitFor(() => {
        expect(page.container.textContent).toContain("Quiz me on today's phrases");
      });
    });
    expect(page.container.textContent).toContain("Learning");
    expect(page.container.textContent).toContain("Clients");
    expect(page.container.textContent).toContain("Draft this week's client note");
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it('"Do it" on an Idea calls onSendIdea with its text', async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.ideas.list.mockResolvedValue([idea({ text: "Plan this Sunday's run", area: "health" })]);
  const onSendIdea = vi.fn();
  const page = await renderIdeas(onSendIdea);
  try {
    const button = [...page.container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === "Do it",
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

it("draws each Idea with a monochrome line icon, never an image", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.ideas.list.mockResolvedValue([
    idea({ text: "Draft the quarterly memo", area: "work", illustration: "rocket" }),
    idea({ id: "idea-2", text: "Draft this week's client note", area: "clients" }),
  ]);
  const page = await renderIdeas();
  try {
    await act(async () => {
      await vi.waitFor(() => {
        expect(page.container.textContent).toContain("Draft the quarterly memo");
      });
    });
    expect(page.container.querySelector("img")).toBeNull();
    expect(page.container.querySelectorAll("li svg")).toHaveLength(2);
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("Dismiss hides an Idea and remembers it", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  });
  api.ideas.list.mockResolvedValue([
    idea({ id: "idea-1", text: "Plan this Sunday's run", area: "health" }),
    idea({ id: "idea-2", text: "Quiz me on today's phrases", area: "learning" }),
  ]);
  const page = await renderIdeas();
  try {
    const dismiss = [...page.container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === "Dismiss",
    );
    await act(async () => {
      dismiss?.click();
    });
    expect(page.container.textContent).not.toContain("Plan this Sunday's run");
    expect(page.container.textContent).toContain("Quiz me on today's phrases");
    expect(store.get("nova.ideas.dismissed.bot-1")).toBe('["idea-1"]');
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("shows an empty state when there are no Ideas yet", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.ideas.list.mockResolvedValue([]);
  const page = await renderIdeas();
  try {
    await act(async () => {
      await vi.waitFor(() => {
        expect(page.container.textContent).toContain("Nothing to suggest yet");
      });
    });
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("accepts and dismisses a background Idea on the server, not by sending its text", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.ideas.list.mockResolvedValue([
    idea({ id: "s-1", text: "Add banking use cases to the brief", area: "suggested" }),
    idea({ id: "s-2", text: "Watch open banking news", area: "suggested" }),
  ]);
  api.ideas.accept.mockResolvedValue({ ok: true });
  api.ideas.dismiss.mockResolvedValue({ ok: true });
  const onSendIdea = vi.fn();
  const view = await renderIdeas(onSendIdea);
  const buttons = (label: string) =>
    [...view.container.querySelectorAll("button")].filter((b) => b.textContent === label);
  await act(async () => buttons("Do it")[0]?.click());
  expect(api.ideas.accept).toHaveBeenCalledWith({ botId: "bot-1", ideaId: "s-1" });
  expect(onSendIdea).not.toHaveBeenCalled();
  await act(async () => buttons("Dismiss")[0]?.click());
  expect(api.ideas.dismiss).toHaveBeenCalledWith({ botId: "bot-1", ideaId: "s-2" });
  expect(view.container.textContent).not.toContain("Watch open banking news");
  await view.cleanup();
});
