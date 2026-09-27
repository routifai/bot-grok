import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { createGoalRepos, mapGoal, mapGoalProposal, mapGoalTask } from "./goals.js";

const baseTask = {
  id: "task-1",
  goalId: "goal-1",
  idx: 0,
  title: "Pick a course",
  status: "pending",
  note: "",
  updatedAt: new Date("2026-09-01T00:00:00.000Z"),
};

const baseProposal = {
  id: "proposal-1",
  goalId: "goal-1",
  reason: "First plan",
  tasks: [{ title: "Pick a course" }, { title: "Book a lesson", keepTaskId: "task-1" }],
  status: "open",
  createdAt: new Date("2026-08-30T00:00:00.000Z"),
};

const baseGoal = {
  id: "goal-1",
  botId: "bot-1",
  title: "Conversational Japanese before Kyoto",
  description: "",
  status: "active",
  due: new Date("2026-12-01T00:00:00.000Z"),
  checkInCrons: ["30 7 * * 1-5"],
  timezone: "America/New_York",
  lastWorkedAt: new Date("2026-09-10T12:00:00.000Z"),
  nextWorkAt: new Date("2026-09-11T12:00:00.000Z"),
  createdAt: new Date("2026-08-30T00:00:00.000Z"),
  updatedAt: new Date("2026-09-10T12:00:00.000Z"),
  tasks: [baseTask],
  proposals: [baseProposal],
};

describe("mapGoalTask", () => {
  it("maps a task row to the contract shape", () => {
    expect(mapGoalTask(baseTask)).toEqual({
      id: "task-1",
      goalId: "goal-1",
      idx: 0,
      title: "Pick a course",
      status: "pending",
      note: "",
      updatedAt: "2026-09-01T00:00:00.000Z",
    });
  });
});

describe("mapGoalProposal", () => {
  it("maps a proposal row and preserves keepTaskId on carried-over tasks", () => {
    const mapped = mapGoalProposal(baseProposal);
    expect(mapped).toEqual({
      id: "proposal-1",
      goalId: "goal-1",
      reason: "First plan",
      tasks: [{ title: "Pick a course" }, { title: "Book a lesson", keepTaskId: "task-1" }],
      status: "open",
      createdAt: "2026-08-30T00:00:00.000Z",
    });
  });

  it("throws when the stored JSON does not match the proposal task shape", () => {
    expect(() => mapGoalProposal({ ...baseProposal, tasks: [{ notATitle: true }] })).toThrow();
  });
});

describe("mapGoal", () => {
  it("maps dates to ISO strings and due to a calendar date", () => {
    const mapped = mapGoal(baseGoal);
    expect(mapped.due).toBe("2026-12-01");
    expect(mapped.createdAt).toBe("2026-08-30T00:00:00.000Z");
    expect(mapped.updatedAt).toBe("2026-09-10T12:00:00.000Z");
    expect(mapped.lastWorkedAt).toBe("2026-09-10T12:00:00.000Z");
    expect(mapped.nextWorkAt).toBe("2026-09-11T12:00:00.000Z");
  });

  it("nulls out due, lastWorkedAt, and nextWorkAt when unset", () => {
    const mapped = mapGoal({
      ...baseGoal,
      due: null,
      lastWorkedAt: null,
      nextWorkAt: null,
    });
    expect(mapped.due).toBeNull();
    expect(mapped.lastWorkedAt).toBeNull();
    expect(mapped.nextWorkAt).toBeNull();
  });

  it("orders tasks as given (callers order by idx) and maps each one", () => {
    const mapped = mapGoal(baseGoal);
    expect(mapped.tasks).toHaveLength(1);
    expect(mapped.tasks[0]).toMatchObject({ id: "task-1", idx: 0 });
  });

  it("surfaces the open proposal and ignores non-open ones", () => {
    const mapped = mapGoal(baseGoal);
    expect(mapped.openProposal?.id).toBe("proposal-1");

    const withoutOpenProposal = mapGoal({
      ...baseGoal,
      proposals: [{ ...baseProposal, status: "accepted" }],
    });
    expect(withoutOpenProposal.openProposal).toBeNull();
  });

  it("returns null openProposal when there are no proposals", () => {
    const mapped = mapGoal({ ...baseGoal, proposals: [] });
    expect(mapped.openProposal).toBeNull();
  });
});

describe("createGoalRepos", () => {
  function reposFor(goals: unknown[]) {
    const prisma = {
      goal: {
        findMany: vi.fn(async () => goals),
        findUnique: vi.fn(async () => goals[0] ?? null),
      },
    };
    return { repos: createGoalRepos(prisma as unknown as PrismaClient), prisma };
  }

  it("listGoals excludes done/cancelled goals by default", async () => {
    const { repos, prisma } = reposFor([baseGoal]);
    const result = await repos.listGoals("bot-1");
    expect(result).toHaveLength(1);
    expect(prisma.goal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { botId: "bot-1", status: { in: ["active", "paused"] } },
      }),
    );
  });

  it("listGoals includes closed goals when asked", async () => {
    const { repos, prisma } = reposFor([baseGoal]);
    await repos.listGoals("bot-1", { includeClosed: true });
    expect(prisma.goal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { botId: "bot-1" } }),
    );
  });

  it("getGoal returns null when the goal does not exist", async () => {
    const { repos } = reposFor([]);
    expect(await repos.getGoal("missing")).toBeNull();
  });

  it("getGoal maps the found goal", async () => {
    const { repos } = reposFor([baseGoal]);
    const result = await repos.getGoal("goal-1");
    expect(result?.id).toBe("goal-1");
    expect(result?.tasks).toHaveLength(1);
  });
});
