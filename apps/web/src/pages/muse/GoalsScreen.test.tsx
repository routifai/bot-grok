// @vitest-environment jsdom

import type { Goal } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
  acceptProposal: vi.fn(),
  dismissProposal: vi.fn(),
  log: vi.fn(),
}));
vi.mock("../../lib/rpc", () => ({ rpc: { goals: api } }));
api.log.mockResolvedValue({ threadId: "thread-1", messages: [], olderCursor: null });

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
vi.mock("@rakazo/chat-ui/web", () => ({
  ChatMarkdown: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@rakazo/ui-web", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    AlertDialog: Container,
    AlertDialogAction: (props: ComponentProps<"button">) => <button {...props} />,
    AlertDialogCancel: (props: ComponentProps<"button">) => <button {...props} />,
    AlertDialogContent: Container,
    AlertDialogDescription: Container,
    AlertDialogFooter: Container,
    AlertDialogHeader: Container,
    AlertDialogTitle: Container,
    Button: ({
      variant: _variant,
      size: _size,
      ...props
    }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
    NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
    Tabs: Container,
    TabsList: Container,
    TabsTrigger: Container,
    TabsContent: Container,
  };
});

import { GoalsScreen } from "./GoalsScreen";

function goal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "goal-1",
    botId: "bot-1",
    title: "Conversational Japanese before Kyoto",
    description: "Hold a simple conversation in Japanese by the trip.",
    status: "active",
    due: "2026-12-10",
    checkInCrons: ["30 7 * * 1-5"],
    timezone: "America/New_York",
    tasks: [
      {
        id: "task-1",
        goalId: "goal-1",
        idx: 0,
        title: "Pick a course",
        status: "done",
        note: "Chose Genki I.",
        updatedAt: "2026-09-20T00:00:00.000Z",
      },
      {
        id: "task-2",
        goalId: "goal-1",
        idx: 1,
        title: "Daily practice streak",
        status: "in_progress",
        note: "",
        updatedAt: "2026-09-21T00:00:00.000Z",
      },
    ],
    openProposal: {
      id: "proposal-1",
      goalId: "goal-1",
      reason: "Adding a weekend conversation club keeps the pace.",
      tasks: [
        { title: "Pick a course" },
        { title: "Join a Saturday conversation club" },
        { title: "Daily practice streak" },
      ],
      status: "open",
      createdAt: "2026-09-24T00:00:00.000Z",
    },
    lastWorkedAt: null,
    nextWorkAt: null,
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z",
    ...overrides,
  };
}

async function renderGoals(botId = "bot-1") {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<GoalsScreen botId={botId} />));
  return {
    container,
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function findButton(container: HTMLElement, text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes(text),
  );
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}

it("lists a seeded Goal and opens its detail with the open Proposal", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.list.mockResolvedValue([goal()]);
  const page = await renderGoals();
  try {
    await act(async () => {
      await vi.waitFor(() => {
        expect(page.container.textContent).toContain("Conversational Japanese before Kyoto");
      });
    });
    await act(async () => {
      page.container.querySelector<HTMLButtonElement>("[data-testid='goal-row']")?.click();
    });
    expect(page.container.textContent).toContain("Adding a weekend conversation club");
    expect(page.container.textContent).toContain("Join a Saturday conversation club");
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("accepts an open Proposal and renders the new plan", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const seeded = goal();
  api.list.mockResolvedValue([seeded]);
  api.acceptProposal.mockResolvedValue({
    ...seeded,
    openProposal: null,
    tasks: [
      seeded.tasks[0],
      {
        id: "task-new",
        goalId: "goal-1",
        idx: 1,
        title: "Join a Saturday conversation club",
        status: "pending",
        note: "",
        updatedAt: "2026-09-25T00:00:00.000Z",
      },
      { ...seeded.tasks[1], idx: 2 },
    ],
  });
  const page = await renderGoals();
  try {
    await act(async () => {
      await vi.waitFor(() => {
        expect(page.container.textContent).toContain("Conversational Japanese before Kyoto");
      });
    });
    await act(async () => {
      page.container.querySelector<HTMLButtonElement>("[data-testid='goal-row']")?.click();
    });
    await act(async () => {
      findButton(page.container, "Accept").click();
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(api.acceptProposal).toHaveBeenCalledWith({ proposalId: "proposal-1" });
      });
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(page.container.querySelector("[data-testid='goal-proposal-card']")).toBeNull();
      });
    });
    const taskList = page.container.querySelector("[data-testid='goal-task-list']");
    expect(taskList?.textContent).toContain("Join a Saturday conversation club");
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("invites the person to tell their Muse a Goal when there are none", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.list.mockResolvedValue([]);
  const page = await renderGoals();
  try {
    await act(async () => {
      await vi.waitFor(() => {
        expect(page.container.textContent).toContain("Tell your Muse");
      });
    });
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});
