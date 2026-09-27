import type { AgentRunRequest } from "@aiden/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";

// Executor-level coverage for B5 (docs/muse/PLAN.md): a Goal-log turn sees its own Goal in
// full plus the Conversation's summary, never another Goal's details; a Conversation turn
// sees the list of active Goals; muse mode off adds neither.

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  provisionComputer: async () => ({ id: "computer-1", kind: "desktop" }),
}));

interface GoalRow {
  id: string;
  botId: string;
  title: string;
  description: string;
  status: string;
  due: Date | null;
  checkInCrons: string[];
  timezone: string;
  lastWorkedAt: Date | null;
  nextWorkAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface GoalTaskRow {
  id: string;
  goalId: string;
  idx: number;
  title: string;
  status: string;
  note: string;
  updatedAt: Date;
}

async function runFixture({
  productMode,
  goalId,
  conversationSummary,
}: {
  productMode?: "muse" | "aiden";
  goalId?: string | null;
  conversationSummary?: string | null;
}) {
  const run = {
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued",
    trigger: "user",
    leaseFence: 0,
  };
  const goals: GoalRow[] = [
    {
      id: "goal-a",
      botId: "bot-1",
      title: "Conversational Japanese before Kyoto",
      description: "",
      status: "active",
      due: null,
      checkInCrons: [],
      timezone: "UTC",
      lastWorkedAt: null,
      nextWorkAt: null,
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    },
    {
      id: "goal-b",
      botId: "bot-1",
      title: "A different Goal entirely",
      description: "",
      status: "active",
      due: null,
      checkInCrons: [],
      timezone: "UTC",
      lastWorkedAt: null,
      nextWorkAt: null,
      createdAt: new Date("2026-08-02T00:00:00.000Z"),
      updatedAt: new Date("2026-08-02T00:00:00.000Z"),
    },
  ];
  const goalTasks: GoalTaskRow[] = [
    {
      id: "task-a1",
      goalId: "goal-a",
      idx: 1,
      title: "Find a tutor",
      status: "pending",
      note: "",
      updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    },
    {
      id: "task-b1",
      goalId: "goal-b",
      idx: 1,
      title: "Some other task",
      status: "pending",
      note: "",
      updatedAt: new Date("2026-08-02T00:00:00.000Z"),
    },
  ];
  const attachRelations = (goal: GoalRow) => ({
    ...goal,
    tasks: goalTasks.filter((task) => task.goalId === goal.id).sort((a, b) => a.idx - b.idx),
    proposals: [] as unknown[],
  });

  const get = vi.fn(async () => new Uint8Array([1, 2, 3, 4]));
  let request: AgentRunRequest | undefined;
  const runtimeRun = vi.fn(async function* (next: AgentRunRequest) {
    request = next;
    yield { type: "done" as const, text: "Done" };
  });
  const prisma = {
    run: {
      findUnique: vi.fn(async () => run),
      findUniqueOrThrow: vi.fn(async () => run),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(run, data);
        return { count: 1 };
      }),
    },
    bot: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.botId,
        name: "Assistant",
        title: "Assistant",
        description: "Test assistant",
        modelProvider: null,
        modelId: null,
        thinkingLevel: null,
        computerId: "computer-1",
        computerSwitching: false,
        memoryScope: null,
        computer: { id: "computer-1", scope: "dedicated" },
      })),
      findMany: vi.fn(async () => []),
    },
    attempt: {
      create: vi.fn(async () => ({ id: "attempt-1" })),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    thread: {
      // The run's own thread: a Goal log (goalId set, no botId) or the Conversation.
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.threadId,
        groupId: null,
        goalId: goalId ?? null,
        historyCompactionSummary: null,
        historyCompactedUpToSeq: null,
        nextMessageSeq: 3,
      })),
      // The Muse's own Conversation thread, looked up by botId for a Goal-log turn.
      findUnique: vi.fn(async ({ where }: { where: { botId?: string } }) =>
        where.botId === run.botId
          ? { historyCompactionSummary: conversationSummary ?? null }
          : null,
      ),
    },
    message: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
    },
    task: { findUniqueOrThrow: vi.fn(async () => ({ id: run.taskId, prompt: "Keep working" })) },
    connection: { findMany: vi.fn(async () => []) },
    spaceModelPreference: { findFirst: vi.fn(async () => null) },
    userModelCredential: { findFirst: vi.fn(async () => null) },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        defaultModelProvider: "openrouter",
        defaultModelId: "deepseek/deepseek-v4-flash-0731",
      })),
    },
    taughtSkill: { findMany: vi.fn(async () => []) },
    agentSecret: { findMany: vi.fn(async () => []) },
    agentSkill: { findMany: vi.fn(async () => []) },
    scratchpadItem: { findMany: vi.fn(async () => []) },
    externalEffect: { findMany: vi.fn(async () => []) },
    artifact: { findMany: vi.fn(async () => []) },
    goal: {
      findMany: vi.fn(async ({ where }: { where: { botId: string; status?: { in: string[] } } }) =>
        goals
          .filter((goal) => goal.botId === where.botId)
          .filter((goal) => !where.status || where.status.in.includes(goal.status))
          .map(attachRelations),
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const goal = goals.find((g) => g.id === where.id);
        return goal ? attachRelations(goal) : null;
      }),
    },
  };
  const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
  const executor = createRunExecutor({
    prisma,
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    sandbox: { describe: () => ({ capabilities: { graphical: false } }) },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: { resolve: async () => null },
    artifacts: { get },
    events: { append: vi.fn(async () => undefined), finalizeRun },
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets: [],
    productMode,
  } as unknown as Parameters<typeof createRunExecutor>[0]);

  await executor.continueRun(run.id, "worker-1");
  expect(runtimeRun).toHaveBeenCalled();
  expect(finalizeRun).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
  if (!request) throw new Error("runtime was not called");
  return request.instructions as string;
}

describe("Goals in context (B5)", () => {
  it("adds neither Goals nor a Conversation summary outside muse mode", async () => {
    const instructions = await runFixture({ productMode: "aiden", goalId: "goal-a" });
    expect(instructions).not.toContain("<goals_active>");
    expect(instructions).not.toContain("<conversation_summary>");
  });

  it("lists every active Goal on a Conversation turn", async () => {
    const instructions = await runFixture({ productMode: "muse", goalId: null });
    expect(instructions).toContain("<goals_active>");
    expect(instructions).toContain("Conversational Japanese before Kyoto");
    expect(instructions).toContain("A different Goal entirely");
    expect(instructions).not.toContain("<conversation_summary>");
  });

  it("includes only its own Goal in full, plus the Conversation summary, on a Goal-log turn", async () => {
    const instructions = await runFixture({
      productMode: "muse",
      goalId: "goal-a",
      conversationSummary: "The person is planning a Kyoto trip in December.",
    });

    expect(instructions).toContain("<goals_active>");
    expect(instructions).toContain("Conversational Japanese before Kyoto");
    expect(instructions).toContain("Find a tutor");
    expect(instructions).not.toContain("A different Goal entirely");
    expect(instructions).not.toContain("Some other task");

    expect(instructions).toContain("<conversation_summary>");
    expect(instructions).toContain("The person is planning a Kyoto trip in December.");
  });
});
