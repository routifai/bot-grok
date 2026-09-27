import type * as AidenAdaptersModule from "@aiden/adapters";
import type { Actor } from "@aiden/contracts";
import type { PrismaClient } from "@aiden/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mocks only the one Proposal apply path so these tests exercise goals.ts's own
// authorization/routing, not goal-proposals.ts's internals (covered in depth by
// packages/adapters/src/muse/goal-tools.test.ts).
vi.mock("@aiden/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof AidenAdaptersModule>()),
  acceptGoalProposal: vi.fn(),
  dismissGoalProposal: vi.fn(),
}));

import { acceptGoalProposal, dismissGoalProposal } from "@aiden/adapters";
import {
  acceptProposal,
  dismissProposal,
  getGoal,
  getGoalLog,
  listGoals,
  updateGoal,
} from "./goals.js";

beforeEach(() => {
  vi.clearAllMocks();
});

const actor: Actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@aiden.test",
  isDeploymentOwner: true,
};

const BOT_ID = "bot-1";
const GOAL_ID = "goal-1";

const baseGoalRow = {
  id: GOAL_ID,
  botId: BOT_ID,
  title: "Conversational Japanese before Kyoto",
  description: "",
  status: "active",
  due: null,
  checkInCrons: ["30 7 * * 1-5"],
  timezone: "America/New_York",
  lastWorkedAt: null,
  nextWorkAt: null,
  createdAt: new Date("2026-08-30T00:00:00.000Z"),
  updatedAt: new Date("2026-09-10T00:00:00.000Z"),
  tasks: [],
  proposals: [],
};

function fakeDeps(
  options: {
    botRow?: unknown;
    goalRow?: unknown;
    threadRow?: unknown;
    messageRows?: unknown[];
  } = {},
) {
  const botFindFirst = vi
    .fn()
    .mockResolvedValue("botRow" in options ? options.botRow : { id: BOT_ID, archivedAt: null });
  const goalFindUnique = vi
    .fn()
    .mockResolvedValue("goalRow" in options ? options.goalRow : baseGoalRow);
  const goalFindFirst = vi.fn().mockResolvedValue({ botId: BOT_ID });
  const goalUpdate = vi
    .fn()
    .mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...baseGoalRow,
      ...data,
    }));
  const goalProposalFindFirst = vi.fn().mockResolvedValue({ goalId: GOAL_ID });
  const threadFindUnique = vi
    .fn()
    .mockResolvedValue("threadRow" in options ? options.threadRow : { id: "thread-goal-1" });
  const messageFindMany = vi.fn().mockResolvedValue(options.messageRows ?? []);
  const prisma = {
    bot: { findFirst: botFindFirst },
    goal: { findUnique: goalFindUnique, findFirst: goalFindFirst, update: goalUpdate },
    goalProposal: { findFirst: goalProposalFindFirst },
    thread: { findUnique: threadFindUnique },
    message: { findMany: messageFindMany },
  } as unknown as PrismaClient;
  const notify = vi.fn().mockResolvedValue(undefined);
  const deps = { prisma, events: { notify } } as unknown as Parameters<typeof listGoals>[0];
  return {
    deps,
    botFindFirst,
    goalFindUnique,
    goalFindFirst,
    goalUpdate,
    goalProposalFindFirst,
    threadFindUnique,
    messageFindMany,
    notify,
  };
}

describe("listGoals", () => {
  it("authorizes like other bot-scoped routes", async () => {
    const { deps, botFindFirst } = fakeDeps({ botRow: null });

    await expect(listGoals(deps, actor, { botId: BOT_ID })).rejects.toThrow();
    expect(botFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: BOT_ID,
          spaceId: actor.spaceId,
          userId: actor.userId,
        }),
      }),
    );
  });
});

describe("getGoal", () => {
  it("returns the Goal when it belongs to the actor's own bot", async () => {
    const { deps } = fakeDeps();
    const goal = await getGoal(deps, actor, GOAL_ID);
    expect(goal.id).toBe(GOAL_ID);
  });

  it("rejects a Goal that does not exist", async () => {
    const { deps } = fakeDeps({ goalRow: null });
    await expect(getGoal(deps, actor, GOAL_ID)).rejects.toThrow();
  });

  it("rejects a Goal whose bot is not the actor's own", async () => {
    const { deps } = fakeDeps({ botRow: null });
    await expect(getGoal(deps, actor, GOAL_ID)).rejects.toThrow();
  });
});

describe("updateGoal", () => {
  it("writes only status, leaving check-ins and timezone untouched", async () => {
    const { deps, goalUpdate } = fakeDeps();

    const updated = await updateGoal(deps, actor, { goalId: GOAL_ID, status: "paused" });

    expect(goalUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: GOAL_ID }, data: { status: "paused" } }),
    );
    expect(updated.status).toBe("paused");
  });

  it("replaces the check-in schedule and timezone together", async () => {
    const { deps, goalUpdate } = fakeDeps();

    await updateGoal(deps, actor, {
      goalId: GOAL_ID,
      checkInCrons: ["0 8 * * *"],
      timezone: "Europe/Paris",
    });

    expect(goalUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { checkInCrons: ["0 8 * * *"], timezone: "Europe/Paris" },
      }),
    );
  });

  it("rejects updating a Goal outside the actor's space", async () => {
    const { deps, goalUpdate } = fakeDeps({ botRow: null });
    await expect(updateGoal(deps, actor, { goalId: GOAL_ID, status: "paused" })).rejects.toThrow();
    expect(goalUpdate).not.toHaveBeenCalled();
  });
});

describe("getGoalLog", () => {
  it("pages the Goal's own Thread, the same shape as threads.messages", async () => {
    const rows = [
      {
        id: "m-1",
        threadId: "thread-goal-1",
        seq: 0,
        role: "bot",
        blocks: [],
        createdAt: new Date(),
      },
    ];
    const { deps, threadFindUnique, messageFindMany } = fakeDeps({ messageRows: rows });

    const page = await getGoalLog(deps, actor, { goalId: GOAL_ID });

    expect(threadFindUnique).toHaveBeenCalledWith({
      where: { goalId: GOAL_ID },
      select: { id: true },
    });
    expect(messageFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ threadId: "thread-goal-1" }) }),
    );
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]?.id).toBe("m-1");
  });

  it("pages older messages with `before`, the same cursor threads.messages uses", async () => {
    const older = {
      id: "m-0",
      threadId: "thread-goal-1",
      seq: 0,
      role: "bot",
      blocks: [],
      createdAt: new Date(),
    };
    const { deps, messageFindMany } = fakeDeps({ messageRows: [older] });

    await getGoalLog(deps, actor, { goalId: GOAL_ID, before: 5 });

    expect(messageFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ threadId: "thread-goal-1", seq: { lt: 5 } }),
      }),
    );
  });

  it("rejects a Goal outside the actor's space before touching the log thread", async () => {
    const { deps, threadFindUnique } = fakeDeps({ botRow: null });
    await expect(getGoalLog(deps, actor, { goalId: GOAL_ID })).rejects.toThrow();
    expect(threadFindUnique).not.toHaveBeenCalled();
  });
});

describe("acceptProposal / dismissProposal", () => {
  it("accepts through the shared goal-proposals.ts apply path after authorizing", async () => {
    const { deps, goalProposalFindFirst } = fakeDeps();
    vi.mocked(acceptGoalProposal).mockResolvedValue({ ...baseGoalRow } as never);

    const result = await acceptProposal(deps, actor, "proposal-1");

    expect(goalProposalFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "proposal-1" } }),
    );
    expect(acceptGoalProposal).toHaveBeenCalledWith(
      expect.objectContaining({ prisma: deps.prisma }),
      "proposal-1",
    );
    expect(result.id).toBe(GOAL_ID);
  });

  it("dismisses through the same shared apply path", async () => {
    const { deps } = fakeDeps();
    vi.mocked(dismissGoalProposal).mockResolvedValue({ ...baseGoalRow } as never);

    await dismissProposal(deps, actor, "proposal-1");

    expect(dismissGoalProposal).toHaveBeenCalledWith(
      expect.objectContaining({ prisma: deps.prisma }),
      "proposal-1",
    );
  });

  it("surfaces an already-decided Proposal as a conflict", async () => {
    const { deps } = fakeDeps();
    vi.mocked(acceptGoalProposal).mockResolvedValue(null);

    await expect(acceptProposal(deps, actor, "proposal-1")).rejects.toThrow(/no longer open/);
  });

  it("rejects a Proposal whose Goal is not the actor's own", async () => {
    const { deps } = fakeDeps({ botRow: null });
    await expect(acceptProposal(deps, actor, "proposal-1")).rejects.toThrow();
    expect(acceptGoalProposal).not.toHaveBeenCalled();
  });
});
