// Confirms the `goals` tool is actually wired into the run engine's dispatch (tool name
// recognized, model args parsed into the shape goal-tools.ts expects) end to end through
// createRunExecutor + a scripted tool call, the same harness executor-effect-idempotency.
// test.ts uses for scratchpad_add. goal-tools.test.ts covers the business logic in depth;
// this file only covers the wiring.
import type { AgentRunRequest } from "@aiden/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type * as AutoReviewModule from "../auto-review.js";
import type * as ComputerLifecycleModule from "../computer-lifecycle.js";
import { createRunExecutor } from "../executor.js";

vi.mock("../computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  provisionComputer: async () => ({ id: "computer-1", kind: "desktop" }),
}));

vi.mock("../auto-review.js", async (importOriginal) => ({
  ...(await importOriginal<typeof AutoReviewModule>()),
  resolveAutoReviewChecker: () => ({ provider: "scripted", model: "checker" }),
  isAutoReviewCheckerConfigured: () => true,
  runAutoReviewJudge: vi.fn(),
}));

type ToolCall = { name: string; args: Record<string, unknown>; executionId: string };

function fixture(runId = "run-1") {
  const results: unknown[] = [];
  const run = {
    id: runId,
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued",
    trigger: "user",
    leaseFence: 0,
  };

  const goals: Record<string, unknown>[] = [];
  const goalTasks: Record<string, unknown>[] = [];
  const goalProposals: Record<string, unknown>[] = [];
  const threads: Record<string, unknown>[] = [
    {
      id: run.threadId,
      spaceId: run.spaceId,
      userId: run.userId,
      botId: run.botId,
      groupId: null,
      goalId: null,
      nextMessageSeq: 0,
      nextEventSeq: 0,
      unread: false,
    },
  ];
  const messages: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  let seq = 0;
  const nextId = (prefix: string) => `${prefix}-${++seq}`;

  // Real dispatch wraps mutating tools (goals included) with an idempotency-key gate over
  // ExternalEffect; this stateful mock mirrors executor-effect-idempotency.test.ts's so that
  // gate resolves normally instead of falling back to "uncertain".
  type Effect = {
    id: string;
    runId?: string;
    kind: string;
    idempotencyKey: string;
    status: string;
    request: unknown;
    result?: unknown;
  };
  const effectRows: Effect[] = [];
  const externalEffect = {
    findMany: vi.fn(
      async ({
        where,
      }: {
        where?: { id?: string; runId?: string; status?: string; kind?: string };
      } = {}) =>
        effectRows.filter((effect) => {
          if (where?.status && effect.status !== where.status) return false;
          if (where?.kind && effect.kind !== where.kind) return false;
          if (where?.runId && effect.runId && effect.runId !== where.runId) return false;
          if (where?.id && effect.id !== where.id) return false;
          return true;
        }),
    ),
    findUnique: vi.fn(
      async ({ where }: { where: { id?: string; idempotencyKey?: string } }) =>
        effectRows.find((effect) =>
          where.id ? effect.id === where.id : effect.idempotencyKey === where.idempotencyKey,
        ) ?? null,
    ),
    create: vi.fn(async ({ data }: { data: Omit<Effect, "id"> }) => {
      const effect = { ...data, id: `effect-${effectRows.length + 1}` };
      effectRows.push(effect);
      return { ...effect };
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Effect> }) => {
      Object.assign(effectRows.find((effect) => effect.id === where.id)!, data);
    }),
    updateMany: vi.fn(
      async ({ where, data }: { where: { id: string; status: string }; data: Partial<Effect> }) => {
        const effect = effectRows.find(
          (candidate) => candidate.id === where.id && candidate.status === where.status,
        );
        if (!effect) return { count: 0 };
        Object.assign(effect, data);
        return { count: 1 };
      },
    ),
  };

  function withRelations(goal: Record<string, unknown>) {
    return {
      ...goal,
      tasks: goalTasks
        .filter((task) => task.goalId === goal.id)
        .sort((a, b) => Number(a.idx) - Number(b.idx)),
      proposals: goalProposals
        .filter((proposal) => proposal.goalId === goal.id && proposal.status === "open")
        .slice(0, 1),
    };
  }

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
        name: "Aiden",
        title: "Muse",
        description: "Test Muse",
        computerId: "computer-1",
        computer: { id: "computer-1", scope: "dedicated" },
      })),
      // scheduleFirstGoalWork (packages/adapters/src/muse/goal-tools.ts, B8) reads the
      // Muse's proactivity/quiet-hours settings after `create` to schedule its first
      // goal.advance / goal.checkin.
      findUnique: vi.fn(async () => ({ museProactivity: null, museQuietHours: null })),
      findMany: vi.fn(async () => []),
    },
    attempt: {
      create: vi.fn(async () => ({ id: "attempt-1" })),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    thread: {
      findUniqueOrThrow: vi.fn(async () => threads.find((t) => t.id === run.threadId)),
      findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const key = Object.keys(where)[0]!;
        return threads.find((t) => t[key] === where[key]) ?? null;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          nextMessageSeq: 0,
          nextEventSeq: 0,
          unread: false,
          ...data,
          id: nextId("thread"),
        };
        threads.push(row);
        return row;
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const thread = threads.find((t) => t.id === where.id)!;
          const patch: Record<string, unknown> = { ...data };
          for (const [key, value] of Object.entries(data)) {
            if (value && typeof value === "object" && "increment" in (value as object)) {
              patch[key] = (Number(thread[key]) || 0) + (value as { increment: number }).increment;
            }
          }
          Object.assign(thread, patch);
          return thread;
        },
      ),
    },
    message: {
      findMany: vi.fn(async () => []),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { createdAt: new Date(), ...data, id: nextId("message") };
        messages.push(row);
        return row;
      }),
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          messages.find((m) => m.id === where.id) ?? null,
      ),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const message = messages.find((m) => m.id === where.id)!;
          Object.assign(message, data);
          return message;
        },
      ),
    },
    event: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { createdAt: new Date(), ...data, id: nextId("event") };
        events.push(row);
        return row;
      }),
    },
    task: {
      findUniqueOrThrow: vi.fn(async () => ({ id: run.taskId, prompt: "Set up a Goal" })),
    },
    user: {
      findUnique: vi.fn(async () => ({ timezone: "UTC" })),
    },
    goal: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const now = new Date();
        const row = {
          description: "",
          status: "active",
          due: null,
          checkInCrons: [],
          timezone: "UTC",
          lastWorkedAt: null,
          nextWorkAt: null,
          createdAt: now,
          updatedAt: now,
          ...data,
          id: nextId("goal"),
        };
        goals.push(row);
        return row;
      }),
      findUnique: vi.fn(
        async ({ where, include }: { where: { id: string }; include?: unknown }) => {
          const goal = goals.find((g) => g.id === where.id);
          return goal ? (include ? withRelations(goal) : goal) : null;
        },
      ),
      // Every turn's goals context (packages/adapters/src/muse/goals-context.ts) lists
      // active Goals for the bot; empty at the start of these fixtures either way.
      findMany: vi.fn(async () => []),
    },
    goalTask: {
      findMany: vi.fn(async () => []),
    },
    goalProposal: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          askMessageId: null,
          decidedAt: null,
          createdAt: new Date(),
          ...data,
          id: nextId("proposal"),
        };
        goalProposals.push(row);
        return row;
      }),
      findFirst: vi.fn(async () => null),
    },
    connection: { findMany: vi.fn(async () => []) },
    spaceModelPreference: { findFirst: vi.fn(async () => null) },
    userModelCredential: { findFirst: vi.fn(async () => null) },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        defaultModelProvider: "scripted",
        defaultModelId: "scripted",
      })),
    },
    taughtSkill: { findMany: vi.fn(async () => []) },
    agentSecret: { findMany: vi.fn(async () => []) },
    agentSkill: { findMany: vi.fn(async () => []) },
    scratchpadItem: { findMany: vi.fn(async () => []) },
    episode: { findMany: vi.fn(async () => []), upsert: vi.fn(async () => ({ id: "episode-1" })) },
    actionApprovalRule: { findMany: vi.fn(async () => []) },
    actionAutoReviewPreference: { findUnique: vi.fn(async () => ({ enabled: false })) },
    externalEffect,
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
  };

  const pauseRunForInput = vi.fn(async () => {
    run.status = "waiting_input";
    return true;
  });
  const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
  const notify = vi.fn(async () => undefined);
  let calls: ToolCall[] = [];
  const runtimeRun = vi.fn(async function* (request: AgentRunRequest) {
    for (const call of calls) {
      const result = await request.executeTool!(call.name, call.args, call.executionId);
      results.push(result);
    }
    yield { type: "done" as const, text: "Done" };
  });

  const executor = createRunExecutor({
    prisma,
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    connector: {
      discoverTools: async () => [],
      resolveCall: async () => undefined,
      execute: async function* () {},
    },
    sandbox: { describe: () => ({ capabilities: { graphical: false } }) },
    memory: {
      describe: () => ({ capabilities: {} }),
      read: async () => ({ documents: [] }),
      search: async () => [],
      commit: vi.fn(async () => ({ revision: "rev-1" })),
      exportMarkdown: async function* () {},
    },
    memoryProviders: { resolve: async () => null },
    events: { append: vi.fn(async () => undefined), pauseRunForInput, finalizeRun, notify },
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);

  return {
    goals,
    goalProposals,
    messages,
    results,
    setCalls(next: ToolCall[]) {
      calls = next;
    },
    async run() {
      run.status = "queued";
      await executor.continueRun(run.id, "worker-1");
      expect(runtimeRun).toHaveBeenCalled();
      expect(finalizeRun).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
    },
  };
}

describe("goals tool dispatch (wired into the run engine)", () => {
  it("creates a Goal and its first-plan Proposal from a scripted create call", async () => {
    const f = fixture("run-goal-create");
    f.setCalls([
      {
        name: "goals",
        args: {
          action: "create",
          title: "Learn Japanese",
          tasks: ["Pick a course", "Book trial lessons"],
        },
        executionId: "call_0",
      },
    ]);

    await f.run();

    expect(f.goals).toHaveLength(1);
    expect(f.goals[0]).toMatchObject({ title: "Learn Japanese", status: "active" });
    expect(f.goalProposals).toHaveLength(1);
    expect(f.goalProposals[0]).toMatchObject({ reason: "First plan", status: "open" });
    expect(f.results[0]).toMatchObject({
      goal: expect.objectContaining({ title: "Learn Japanese", tasks: [] }),
    });
  });
});
