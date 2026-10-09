import type {
  AgentHomeStore,
  BackgroundJobHandlers,
  JobPublisher,
  MessagingSurface,
  SandboxProvider,
} from "@nova/adapter-kit";
import { messagingDeliverJob } from "@nova/adapter-kit";
import { cancelRunsInTransaction, type PrismaClient, type ThreadEvents } from "@nova/db";
import { getLogger } from "@nova/logging";
import { expireComputerControl } from "./computer-control.js";
import { scheduleComputerSleep, sleepComputerIfIdle } from "./computer-idle.js";
import { performComputerUpdate } from "./computer-update.js";
import { deliverMessagingOutbound, mirrorMessagingOutbound } from "./messaging-delivery.js";
import type { OmnigentGatewayDeps } from "./omnigent/gateway.js";
import { failRunUnsupportedOnOmnigent, runTurnOnOmnigent } from "./omnigent/gateway.js";
import { wakeRoutine } from "./routine-wakeup.js";
import { expireTaughtSkillTeaching } from "./teaching-session.js";

export function createBackgroundJobHandlers(deps: {
  prisma: PrismaClient;
  sandbox: SandboxProvider;
  home: AgentHomeStore;
  jobs: JobPublisher;
  events: ThreadEvents;
  workerId: string;
  /**
   * May this person act now (active, and verified or allowed unverified). Defaults to a status
   * check; composition roots pass the deployment's full rule.
   */
  userMayAct?: (userId: string) => Promise<boolean>;
  messaging?: MessagingSurface;
  /**
   * Omnigent chat engine (docs/omnigent-spike.md): every run.continue runs on it. Unset (no
   * OMNIGENT_URL / OMNIGENT_PROXY_SECRET) there is no engine: runs fail instead of falling
   * back to the retired Pi executor.
   */
  omnigent?: OmnigentGatewayDeps;
}): BackgroundJobHandlers {
  const deliverMessaging = async (runId?: string) => {
    if (!deps.messaging) return;
    await deliverMessagingOutbound(
      { prisma: deps.prisma, messaging: deps.messaging, events: deps.events, jobs: deps.jobs },
      { runId },
      {
        operationId: `messaging.deliver:${runId ?? "drain"}`,
        traceId: `messaging.deliver:${runId ?? "drain"}`,
        spaceId: "",
        userId: "",
        signal: new AbortController().signal,
      },
    );
  };

  const continueOnEngine = async (runId: string, workerId: string) => {
    if (!deps.omnigent) return;
    const ran = await runTurnOnOmnigent(deps.omnigent, runId, workerId);
    if (!ran) await failRunUnsupportedOnOmnigent(deps.omnigent, runId, workerId);
  };

  // Background work runs as a person, so it stops when that person is no longer active
  // (suspended, or still waiting for approval).
  const isActive =
    deps.userMayAct ??
    (async (userId: string) =>
      (await deps.prisma.user.findUnique({ where: { id: userId }, select: { status: true } }))
        ?.status === "active");

  return {
    "run.continue": async (payload) => {
      const run = await deps.prisma.run.findUnique({
        where: { id: payload.runId },
        select: { id: true, taskId: true, userId: true },
      });
      if (run && !(await isActive(run.userId))) {
        getLogger().warn("run.continue cancelled: account is not active", { runId: run.id });
        await deps.prisma.$transaction((tx) => cancelRunsInTransaction(tx, [run], new Date()));
        return;
      }
      if (deps.omnigent) {
        await continueOnEngine(payload.runId, deps.workerId);
      } else {
        // No engine configured: nothing can run this turn.
        getLogger().error("run.continue skipped: no engine configured", { runId: payload.runId });
      }
      // Automatic messaging mirror: once the run's bot messages are durable,
      // copy them into the outbox. Never let mirror failures fail the run.
      if (deps.messaging) {
        await mirrorMessagingOutbound(
          { prisma: deps.prisma, messaging: deps.messaging, events: deps.events, jobs: deps.jobs },
          payload.runId,
        );
        await deps.jobs.enqueue(messagingDeliverJob()).catch(async (error) => {
          getLogger().error("messaging.deliver enqueue error", error);
          await deliverMessaging();
        });
      }
    },
    "messaging.deliver": async (payload) => {
      await deliverMessaging(payload.runId);
    },
    "routine.wakeup": async (payload) => {
      const routine = await deps.prisma.routine.findUnique({
        where: { id: payload.routineId },
        select: { userId: true },
      });
      if (routine && !(await isActive(routine.userId))) return;
      await wakeRoutine(deps, payload.routineId, payload.scheduledFor);
    },
    "computer.update": async ({ updateId }) => {
      await performComputerUpdate(deps, updateId);
    },
    // The engine's Computer is always on: no idle sleep or control expiry for its Muses.
    "computer.sleep": async (payload) => {
      if (deps.omnigent) return;
      await sleepComputerIfIdle(deps, payload.computerId);
    },
    "computer.control-expire": async (payload) => {
      if (deps.omnigent) return;
      if (await expireComputerControl(deps, payload.computerId, payload.leaseId)) {
        scheduleComputerSleep(deps.jobs, payload.computerId);
      }
    },
    "skill.teaching-expire": async (payload) => {
      await expireTaughtSkillTeaching(deps, payload.skillId);
    },
  };
}
