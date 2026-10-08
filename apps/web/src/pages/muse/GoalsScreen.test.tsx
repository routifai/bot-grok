// @vitest-environment jsdom

import type { Goal } from "@aiden/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("react-dom/client", async (orig) =>
  (await import("../../test/i18n")).withI18nRoot(await orig<typeof import("react-dom/client")>()),
);

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
vi.mock("@aiden/chat-ui/web", () => ({
  ChatMarkdown: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@aiden/ui-web", () => {
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
    BotAvatar: () => <div data-testid="bot-avatar" />,
    Button: ({
      variant: _variant,
      size: _size,
      ...props
    }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
    DropdownMenu: Container,
    DropdownMenuContent: Container,
    DropdownMenuItem: ({
      variant: _variant,
      ...props
    }: ComponentProps<"button"> & { variant?: string }) => <button type="button" {...props} />,
    DropdownMenuTrigger: Container,
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
    NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
    Skeleton: (props: ComponentProps<"div">) => <div {...props} />,
    Tabs: Container,
    TabsList: Container,
    TabsTrigger: Container,
    TabsContent: Container,
    cn: (...inputs: unknown[]) => inputs.filter(Boolean).join(" "),
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

async function renderGoals(botId = "bot-1", onSendIdea: (text: string) => void = vi.fn()) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<GoalsScreen botId={botId} onSendIdea={onSendIdea} />));
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
      findButton(page.container, "Use the new plan").click();
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(api.acceptProposal).toHaveBeenCalledWith({
          goalId: "goal-1",
          proposalId: "proposal-1",
        });
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
        expect(page.container.textContent).toContain("something bigger than a message");
      });
    });
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("tapping an empty-state suggestion chip calls onSendIdea with its text", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.list.mockResolvedValue([]);
  const onSendIdea = vi.fn();
  const page = await renderGoals("bot-1", onSendIdea);
  try {
    await act(async () => {
      await vi.waitFor(() => {
        expect(page.container.textContent).toContain("Prep the Q3 client portfolio review");
      });
    });
    const button = findButton(page.container, "Prep the Q3 client portfolio review");
    await act(async () => {
      button.click();
    });
    expect(onSendIdea).toHaveBeenCalledWith(
      "Help me prepare the Q3 client portfolio review for my book of clients.",
    );
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("shows 'No plan yet' for a goal without a plan, and Plan it asks the Muse in the Conversation", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.list.mockResolvedValue([goal({ tasks: [], openProposal: null })]);
  const onSendIdea = vi.fn();
  const page = await renderGoals("bot-1", onSendIdea);
  try {
    await act(async () => {
      await vi.waitFor(() => {
        expect(page.container.textContent).toContain("No plan yet");
      });
    });
    expect(page.container.textContent).not.toContain("On track");
    await act(async () => {
      page.container.querySelector<HTMLButtonElement>("[data-testid='goal-row']")?.click();
    });
    await act(async () => {
      findButton(page.container, "Plan it").click();
    });
    expect(onSendIdea).toHaveBeenCalledWith(
      'Please propose a plan for my goal "Conversational Japanese before Kyoto".',
    );
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});
