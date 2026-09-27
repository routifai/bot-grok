// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  ideas: { list: vi.fn(), refresh: vi.fn() },
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
vi.mock("@aiden/ui-web", () => ({
  Button: (props: ComponentProps<"button">) => <button type="button" {...props} />,
  Skeleton: (props: ComponentProps<"div">) => <div {...props} />,
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
}));

import type { Idea } from "@aiden/contracts";
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

it("tapping an Idea row calls onSendIdea with its text", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.ideas.list.mockResolvedValue([idea({ text: "Plan this Sunday's run", area: "health" })]);
  const onSendIdea = vi.fn();
  const page = await renderIdeas(onSendIdea);
  try {
    const button = [...page.container.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.startsWith("Plan this Sunday's run"),
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
