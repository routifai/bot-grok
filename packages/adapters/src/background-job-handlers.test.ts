import type {
  AgentHomeStore,
  JobPublisher,
  MessagingSurface,
  SandboxProvider,
} from "@nova/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@nova/db";
import { createLogger, createTestSink, installLogger } from "@nova/logging";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBackgroundJobHandlers } from "./background-job-handlers.js";
import { deliverMessagingOutbound, mirrorMessagingOutbound } from "./messaging-delivery.js";
import type { OmnigentGatewayDeps } from "./omnigent/gateway.js";
import { failRunUnsupportedOnOmnigent, runTurnOnOmnigent } from "./omnigent/gateway.js";
import { wakeRoutine } from "./routine-wakeup.js";

vi.mock("./messaging-delivery.js", () => ({
  deliverMessagingOutbound: vi.fn(async () => undefined),
  mirrorMessagingOutbound: vi.fn(async () => undefined),
}));
vi.mock("./omnigent/gateway.js", () => ({
  runTurnOnOmnigent: vi.fn(async () => true),
  failRunUnsupportedOnOmnigent: vi.fn(async () => undefined),
}));
vi.mock("./routine-wakeup.js", () => ({ wakeRoutine: vi.fn(async () => undefined) }));

/** Just the lookups the handlers make; any other database call would throw. */
function prismaFor(status: string) {
  const self = {
    run: {
      findUnique: vi.fn(async () => ({ id: "run-1", taskId: "task-1", userId: "user-1" })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    routine: { findUnique: vi.fn(async () => ({ userId: "user-1" })) },
    user: { findUnique: vi.fn(async () => ({ status })) },
    attempt: { updateMany: vi.fn(async () => ({ count: 0 })) },
    task: { updateMany: vi.fn(async () => ({ count: 1 })) },
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run(self),
  };
  return self;
}

function handlersFor(overrides: {
  status?: string;
  userMayAct?: (userId: string) => Promise<boolean>;
  prisma?: unknown;
  jobs?: JobPublisher;
  messaging?: MessagingSurface;
  omnigent?: OmnigentGatewayDeps;
}) {
  return createBackgroundJobHandlers({
    // Any Computer or database lookup would throw on these empty clients.
    prisma: (overrides.prisma ??
      prismaFor(overrides.status ?? "active")) as unknown as PrismaClient,
    sandbox: {} as unknown as SandboxProvider,
    home: {} as unknown as AgentHomeStore,
    jobs: overrides.jobs ?? ({ enqueue: vi.fn() } as unknown as JobPublisher),
    events: {} as unknown as ThreadEvents,
    workerId: "worker-1",
    userMayAct: overrides.userMayAct,
    messaging: overrides.messaging,
    omnigent: overrides.omnigent,
  });
}

describe("createBackgroundJobHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delivers directly when shutdown rejects a completed run's mirror job", async () => {
    const enqueueError = new Error("Background job publisher is closing");
    const jobs = {
      enqueue: vi.fn(async () => {
        throw enqueueError;
      }),
    } as unknown as JobPublisher;
    const sink = createTestSink();
    installLogger(createLogger({ service: "nova-worker", sinks: [sink] }));
    const handlers = handlersFor({
      jobs,
      messaging: {} as unknown as MessagingSurface,
      omnigent: {} as unknown as OmnigentGatewayDeps,
    });

    await handlers["run.continue"]({ runId: "run-1" });

    expect(mirrorMessagingOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ prisma: expect.anything(), messaging: expect.anything(), jobs }),
      "run-1",
    );
    expect(deliverMessagingOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ prisma: expect.anything(), messaging: expect.anything(), jobs }),
      { runId: undefined },
      expect.objectContaining({ operationId: "messaging.deliver:drain" }),
    );
    expect(sink.events.some((event) => event.message === "messaging.deliver enqueue error")).toBe(
      true,
    );
    installLogger(createLogger({ service: "nova-worker", level: "off", sinks: [] }));
  });

  it("runs every turn on the engine and never falls back to a Pi executor", async () => {
    const omnigent = {} as unknown as OmnigentGatewayDeps;
    const handlers = handlersFor({ omnigent });

    await handlers["run.continue"]({ runId: "run-1" });

    expect(runTurnOnOmnigent).toHaveBeenCalledWith(omnigent, "run-1", "worker-1");
    expect(failRunUnsupportedOnOmnigent).not.toHaveBeenCalled();
  });

  it("fails a run the engine cannot take instead of retrying it", async () => {
    vi.mocked(runTurnOnOmnigent).mockResolvedValueOnce(false);
    const omnigent = {} as unknown as OmnigentGatewayDeps;
    const handlers = handlersFor({ omnigent });

    await handlers["run.continue"]({ runId: "run-2" });

    expect(failRunUnsupportedOnOmnigent).toHaveBeenCalledWith(omnigent, "run-2", "worker-1");
  });

  it("wakes a routine through the shared routine wakeup", async () => {
    const handlers = handlersFor({});

    await handlers["routine.wakeup"]({
      routineId: "routine-1",
      scheduledFor: "2030-01-01T00:00:00.000Z",
    });

    expect(wakeRoutine).toHaveBeenCalledWith(
      expect.objectContaining({ prisma: expect.anything(), jobs: expect.anything() }),
      "routine-1",
      "2030-01-01T00:00:00.000Z",
    );
  });

  it("leaves the engine's always-on Computer alone: no idle sleep or control expiry", async () => {
    const jobs = { enqueue: vi.fn() } as unknown as JobPublisher;
    const handlers = handlersFor({ jobs, omnigent: {} as unknown as OmnigentGatewayDeps });

    await handlers["computer.sleep"]({ computerId: "computer-1" });
    await handlers["computer.control-expire"]({ computerId: "computer-1", leaseId: "lease-1" });

    expect(jobs.enqueue).not.toHaveBeenCalled();
  });

  it("cancels a run and skips a routine wakeup for an account that is not active", async () => {
    for (const status of ["suspended", "pending"]) {
      const prisma = prismaFor(status);
      const handlers = handlersFor({
        prisma,
        omnigent: {} as unknown as OmnigentGatewayDeps,
      });
      await handlers["run.continue"]({ runId: "run-1" });
      expect(runTurnOnOmnigent).not.toHaveBeenCalled();
      expect(prisma.run.updateMany).toHaveBeenCalled();
      await handlers["routine.wakeup"]({ routineId: "routine-1", scheduledFor: "2026-01-01" });
      expect(wakeRoutine).not.toHaveBeenCalled();
    }
  });

  it("uses the deployment's full rule when one is supplied", async () => {
    const prisma = prismaFor("active");
    const userMayAct = vi.fn(async () => false);
    const handlers = handlersFor({
      prisma,
      userMayAct,
      omnigent: {} as unknown as OmnigentGatewayDeps,
    });
    await handlers["run.continue"]({ runId: "run-1" });
    expect(userMayAct).toHaveBeenCalledWith("user-1");
    expect(runTurnOnOmnigent).not.toHaveBeenCalled();
    expect(prisma.run.updateMany).toHaveBeenCalled();
  });
});
