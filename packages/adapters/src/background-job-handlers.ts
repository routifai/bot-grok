import type {
  AgentHomeStore,
  BackgroundJobHandlers,
  JobPublisher,
  MessagingSurface,
  SandboxProvider,
} from "@nova/adapter-kit";
import { messagingDeliverJob } from "@nova/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@nova/db";
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

  return {
    "run.continue": async (payload) => {
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
