import type { BackgroundJob, JobPublisher } from "@superchat/adapter-kit";
import type { Pool, PrismaClient, ThreadEvents } from "@superchat/db";
import { describe, expect, it, vi } from "vitest";
import { returnBotMessageOutcome } from "./bot-messages.js";
import {
  createJobReconciler,
  createPostgresReconciliationLeadership,
  type ReconciliationLeadership,
} from "./job-reconciler.js";

vi.mock("./bot-messages.js", () => ({ returnBotMessageOutcome: vi.fn() }));

function publisher() {
  const enqueue = vi.fn(async (_job: BackgroundJob) => undefined);
  const jobs: JobPublisher = {
    enqueue,
    cancel: async () => undefined,
    close: async () => undefined,
  };
  return { jobs, enqueue };
}

function fakePrisma(
  runs: Array<{ id: string; updatedAt: Date }> = [],
  routines: Array<{ id: string; nextRunAt: Date | null }> = [],
) {
  return {
    run: { findMany: vi.fn(async () => runs) },
    routine: { findMany: vi.fn(async () => routines) },
    messagingOutbound: { findFirst: vi.fn(async () => null) },
  } as unknown as PrismaClient;
}

describe("createJobReconciler", () => {
  it("continues the main scans when an auxiliary reconciler fails", async () => {
    const prisma = fakePrisma();
    const { jobs } = publisher();
    const reconcileComputerUpdates = vi.fn(() => {
      throw new Error("queue unavailable");
    });
    await createJobReconciler({
      prisma,
      jobs,
      reconcileComputerUpdates,
    }).reconcileOnce();
    expect(reconcileComputerUpdates).toHaveBeenCalledOnce();
    expect(prisma.run.findMany).toHaveBeenCalled();
    expect(prisma.routine.findMany).toHaveBeenCalled();
    expect(prisma.messagingOutbound.findFirst).toHaveBeenCalled();
  });

  it("restores a due pending messaging outbox drain", async () => {
    const prisma = fakePrisma();
    vi.mocked(prisma.messagingOutbound.findFirst).mockResolvedValue({ id: "outbound-1" } as never);
    const { jobs, enqueue } = publisher();

    await createJobReconciler({ prisma, jobs }).reconcileOnce();

    expect(prisma.messagingOutbound.findFirst).toHaveBeenCalledWith({
      where: {
        status: "pending",
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: expect.any(Date) } }],
      },
      select: { id: true },
    });
    expect(enqueue).toHaveBeenCalledWith({
      name: "messaging.deliver",
      payload: {},
      replaceKey: "messaging.deliver:drain",
    });
  });

  it("restores a completed messaging run that was not durably mirrored", async () => {
    const prisma = fakePrisma();
    vi.mocked(prisma.run.findMany)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "run-unmirrored" }] as never);
    const { jobs, enqueue } = publisher();

    await createJobReconciler({ prisma, jobs }).reconcileOnce();

    expect(prisma.run.findMany).toHaveBeenCalledWith({
      where: { trigger: "messaging", status: "completed", messagingMirroredAt: null },
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      take: 100,
      select: { id: true },
    });
    expect(enqueue).toHaveBeenCalledWith({
      name: "messaging.deliver",
      payload: { runId: "run-unmirrored" },
      replaceKey: "messaging.deliver:run-unmirrored",
    });
  });

  it("restores queued runs and near-due routines with stable replacement keys", async () => {
    const scheduledFor = new Date(Date.now() + 30_000);
    const prisma = fakePrisma(
      [{ id: "run-1", updatedAt: new Date() }],
      [{ id: "routine-1", nextRunAt: scheduledFor }],
    );
    const { jobs, enqueue } = publisher();
    const reconciler = createJobReconciler({ prisma, jobs });

    await reconciler.reconcileOnce();

    expect(enqueue).toHaveBeenCalledWith({
      name: "run.continue",
      payload: { runId: "run-1" },
      replaceKey: "run:run-1",
    });
    expect(enqueue).toHaveBeenCalledWith({
      name: "routine.wakeup",
      payload: { routineId: "routine-1", scheduledFor: scheduledFor.toISOString() },
      availableAt: scheduledFor,
      replaceKey: "routine:routine-1",
    });
  });

  it("advances stable cursors so recoverable work beyond one batch is dispatched", async () => {
    const at = new Date("2026-01-01T00:00:00.000Z");
    const runs = Array.from({ length: 5 }, (_, index) => ({
      id: `run-${index + 1}`,
      updatedAt: at,
    }));
    const routines = Array.from({ length: 5 }, (_, index) => ({
      id: `routine-${index + 1}`,
      nextRunAt: new Date(at.getTime() + index),
    }));
    const runPages = [runs.slice(0, 2), runs.slice(2, 4), runs.slice(4)];
    let runPage = 0;
    const runFindMany = vi.fn(async (args: { where?: Record<string, unknown> } = {}) =>
      args.where?.messagingMirroredAt === null ? [] : (runPages[runPage++] ?? []),
    );
    const routineFindMany = vi
      .fn()
      .mockResolvedValueOnce(routines.slice(0, 2))
      .mockResolvedValueOnce(routines.slice(2, 4))
      .mockResolvedValueOnce(routines.slice(4));
    const prisma = {
      run: { findMany: runFindMany },
      routine: { findMany: routineFindMany },
      computer: { findMany: vi.fn(async () => []) },
      messagingOutbound: { findFirst: vi.fn(async () => null) },
    } as unknown as PrismaClient;
    const { jobs, enqueue } = publisher();
    const reconciler = createJobReconciler({ prisma, jobs }, { batchSize: 2 });

    await reconciler.reconcileOnce();
    await reconciler.reconcileOnce();
    await reconciler.reconcileOnce();

    expect(enqueue).toHaveBeenCalledTimes(10);
    expect(enqueue.mock.calls.map(([job]) => job.replaceKey)).toEqual([
      "run:run-1",
      "run:run-2",
      "routine:routine-1",
      "routine:routine-2",
      "run:run-3",
      "run:run-4",
      "routine:routine-3",
      "routine:routine-4",
      "run:run-5",
      "routine:routine-5",
    ]);
    expect(runFindMany.mock.calls[2]?.[0]).toMatchObject({
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      where: {
        AND: [
          expect.anything(),
          {
            OR: [{ updatedAt: { gt: at } }, { updatedAt: at, id: { gt: "run-2" } }],
          },
        ],
      },
    });
    expect(routineFindMany.mock.calls[1]?.[0]).toMatchObject({
      orderBy: [{ nextRunAt: "asc" }, { id: "asc" }],
      where: {
        AND: [
          expect.anything(),
          {
            OR: [
              { nextRunAt: { gt: routines[1]?.nextRunAt } },
              {
                nextRunAt: routines[1]?.nextRunAt,
                id: { gt: "routine-2" },
              },
            ],
          },
        ],
      },
    });
  });

  it("does not scan when another replica is the reconciliation leader", async () => {
    const prisma = fakePrisma();
    const leadership: ReconciliationLeadership = {
      tryAcquire: vi.fn(async () => false),
      release: vi.fn(async () => undefined),
    };
    const { jobs, enqueue } = publisher();
    const reconciler = createJobReconciler({ prisma, jobs, leadership });

    await reconciler.reconcileOnce();
    await reconciler.stop();

    expect(prisma.run.findMany).not.toHaveBeenCalled();
    expect(prisma.routine.findMany).not.toHaveBeenCalled();
    expect(prisma.messagingOutbound.findFirst).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(leadership.release).toHaveBeenCalledOnce();
  });

  it("retries terminal bot outcomes that were not returned", async () => {
    const terminalRun = {
      id: "run-terminal",
      spaceId: "workspace-1",
      threadId: "thread-1",
      botId: "bot-1",
      userId: "user-1",
      sourceMessageId: "message-1",
      status: "completed",
      error: null,
      bot: { name: "Researcher" },
    };
    let terminalScan = 0;
    const runFindMany = vi.fn(async (args: { where?: Record<string, unknown> } = {}) => {
      if (args.where?.messagingMirroredAt === null) return [];
      if (args.where?.trigger === "bot_message") {
        terminalScan += 1;
        return terminalScan === 2 ? [] : [terminalRun];
      }
      return [];
    });
    const prisma = {
      run: { findMany: runFindMany, updateMany: vi.fn(async () => ({ count: 1 })) },
      routine: { findMany: vi.fn(async () => []) },
      computer: { findMany: vi.fn(async () => []) },
      messagingOutbound: { findFirst: vi.fn(async () => null) },
      message: {
        findMany: vi.fn(async () => [
          { blocks: [{ kind: "text", text: "Finished." }], clientNonce: null },
        ]),
      },
    } as unknown as PrismaClient;
    const { jobs } = publisher();
    const events = { notify: vi.fn() } as unknown as ThreadEvents;
    vi.mocked(returnBotMessageOutcome).mockResolvedValue(true).mockResolvedValueOnce(false);

    const reconciler = createJobReconciler({ prisma, jobs, events }, { batchSize: 1 });

    await reconciler.reconcileOnce();
    await reconciler.reconcileOnce();
    await reconciler.reconcileOnce();

    expect(runFindMany).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        where: {
          trigger: "bot_message",
          status: { in: ["completed", "failed"] },
          botOutcomeReturnedAt: null,
        },
      }),
    );
    expect(returnBotMessageOutcome).toHaveBeenCalledWith(
      { prisma, jobs, events },
      terminalRun,
      { id: "bot-1", name: "Researcher" },
      "Finished.",
      "result",
    );
    expect(prisma.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: terminalRun.id, botOutcomeReturnedAt: null },
        data: { updatedAt: expect.any(Date) },
      }),
    );
    expect(returnBotMessageOutcome).toHaveBeenCalledTimes(2);
  });

  it("prefers the latest final reply over earlier untagged narration", async () => {
    const terminalRun = {
      id: "run-pending",
      spaceId: "workspace-1",
      threadId: "thread-1",
      botId: "bot-1",
      userId: "user-1",
      sourceMessageId: "message-1",
      status: "completed",
      error: null,
      bot: { name: "Researcher" },
    };
    const runFindMany = vi.fn(async (args: { where?: Record<string, unknown> } = {}) => {
      if (args.where?.messagingMirroredAt === null) return [];
      if (args.where?.trigger === "bot_message") return [terminalRun];
      return [];
    });
    const prisma = {
      run: { findMany: runFindMany, updateMany: vi.fn(async () => ({ count: 1 })) },
      routine: { findMany: vi.fn(async () => []) },
      computer: { findMany: vi.fn(async () => []) },
      messagingOutbound: { findFirst: vi.fn(async () => null) },
      message: {
        findMany: vi.fn(async () => [
          {
            blocks: [{ kind: "text", text: "Opening the calendar app…" }],
            clientNonce: null,
          },
          {
            blocks: [{ kind: "text", text: "Tuesday afternoon works." }],
            clientNonce: null,
          },
        ]),
      },
    } as unknown as PrismaClient;
    const { jobs } = publisher();
    const events = { notify: vi.fn() } as unknown as ThreadEvents;
    vi.mocked(returnBotMessageOutcome).mockResolvedValue(true);

    const reconciler = createJobReconciler({ prisma, jobs, events }, { batchSize: 1 });
    await reconciler.reconcileOnce();

    expect(returnBotMessageOutcome).toHaveBeenCalledWith(
      { prisma, jobs, events },
      terminalRun,
      { id: "bot-1", name: "Researcher" },
      "Tuesday afternoon works.",
      "result",
    );
  });

  it("prefers the final reply over progress when reconciling", async () => {
    const terminalRun = {
      id: "run-mixed",
      spaceId: "workspace-1",
      threadId: "thread-1",
      botId: "bot-1",
      userId: "user-1",
      sourceMessageId: "message-1",
      status: "completed",
      error: null,
      bot: { name: "Researcher" },
    };
    const runFindMany = vi.fn(async (args: { where?: Record<string, unknown> } = {}) => {
      if (args.where?.messagingMirroredAt === null) return [];
      if (args.where?.trigger === "bot_message") return [terminalRun];
      return [];
    });
    const prisma = {
      run: { findMany: runFindMany, updateMany: vi.fn(async () => ({ count: 1 })) },
      routine: { findMany: vi.fn(async () => []) },
      computer: { findMany: vi.fn(async () => []) },
      messagingOutbound: { findFirst: vi.fn(async () => null) },
      message: {
        findMany: vi.fn(async () => [
          {
            blocks: [{ kind: "text", text: "Checking calendars…" }],
            clientNonce: "user-progress:run-mixed:0",
          },
          {
            blocks: [{ kind: "text", text: "Tuesday afternoon works." }],
            clientNonce: null,
          },
        ]),
      },
    } as unknown as PrismaClient;
    const { jobs } = publisher();
    const events = { notify: vi.fn() } as unknown as ThreadEvents;
    vi.mocked(returnBotMessageOutcome).mockResolvedValue(true);

    const reconciler = createJobReconciler({ prisma, jobs, events }, { batchSize: 1 });
    await reconciler.reconcileOnce();

    expect(returnBotMessageOutcome).toHaveBeenCalledWith(
      { prisma, jobs, events },
      terminalRun,
      { id: "bot-1", name: "Researcher" },
      "Tuesday afternoon works.",
      "result",
    );
  });

  it("returns progress-only transcripts as status", async () => {
    const terminalRun = {
      id: "run-progress",
      spaceId: "workspace-1",
      threadId: "thread-1",
      botId: "bot-1",
      userId: "user-1",
      sourceMessageId: "message-1",
      status: "completed",
      error: null,
      bot: { name: "Researcher" },
    };
    const runFindMany = vi.fn(async (args: { where?: Record<string, unknown> } = {}) => {
      if (args.where?.messagingMirroredAt === null) return [];
      if (args.where?.trigger === "bot_message") return [terminalRun];
      return [];
    });
    const prisma = {
      run: { findMany: runFindMany, updateMany: vi.fn(async () => ({ count: 1 })) },
      routine: { findMany: vi.fn(async () => []) },
      computer: { findMany: vi.fn(async () => []) },
      messagingOutbound: { findFirst: vi.fn(async () => null) },
      message: {
        findMany: vi.fn(async () => [
          {
            blocks: [{ kind: "text", text: "Checking calendars…" }],
            clientNonce: "user-progress:run-progress:0",
          },
        ]),
      },
    } as unknown as PrismaClient;
    const { jobs } = publisher();
    const events = { notify: vi.fn() } as unknown as ThreadEvents;
    vi.mocked(returnBotMessageOutcome).mockResolvedValue(true);

    const reconciler = createJobReconciler({ prisma, jobs, events }, { batchSize: 1 });
    await reconciler.reconcileOnce();

    expect(returnBotMessageOutcome).toHaveBeenCalledWith(
      { prisma, jobs, events },
      terminalRun,
      { id: "bot-1", name: "Researcher" },
      "Checking calendars…",
      "status",
    );
  });
});

describe("createPostgresReconciliationLeadership", () => {
  it("retains leadership for one replica and transfers it after release", async () => {
    let locked = false;
    const clients: Array<{
      query: ReturnType<typeof vi.fn>;
      release: ReturnType<typeof vi.fn>;
      once: ReturnType<typeof vi.fn>;
      removeListener: ReturnType<typeof vi.fn>;
    }> = [];
    const pool = {
      connect: vi.fn(async () => {
        const client = {
          query: vi.fn(async (sql: string) => {
            if (sql.includes("pg_try_advisory_lock")) {
              const acquired = !locked;
              if (acquired) locked = true;
              return { rows: [{ acquired }] };
            }
            const released = locked;
            locked = false;
            return { rows: [{ released }] };
          }),
          release: vi.fn(),
          once: vi.fn(),
          removeListener: vi.fn(),
        };
        clients.push(client);
        return client;
      }),
    } as unknown as Pick<Pool, "connect">;
    const first = createPostgresReconciliationLeadership(pool);
    const second = createPostgresReconciliationLeadership(pool);

    await expect(first.tryAcquire()).resolves.toBe(true);
    await expect(first.tryAcquire()).resolves.toBe(true);
    await expect(second.tryAcquire()).resolves.toBe(false);
    expect(pool.connect).toHaveBeenCalledTimes(2);
    expect(clients[1]?.release).toHaveBeenCalledOnce();

    await first.release();
    await expect(second.tryAcquire()).resolves.toBe(true);
    expect(clients[0]?.removeListener).toHaveBeenCalledWith("error", expect.any(Function));
    expect(clients[0]?.release).toHaveBeenCalledWith(false);
  });
});
