import type {
  AgentHomeStore,
  AgentRuntime,
  BackgroundJobHandlers,
  JobPublisher,
  MemoryStore,
  MessagingSurface,
  SandboxProvider,
} from "@aiden/adapter-kit";
import { ideasRefreshJob, messagingDeliverJob } from "@aiden/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@aiden/db";
import { getLogger } from "@aiden/logging";
import type { CloudAgentConnection } from "./cloud-agent-factory.js";
import { pollCloudAgent } from "./cloud-agent-poll.js";
import { expireComputerControl } from "./computer-control.js";
import { scheduleComputerSleep, sleepComputerIfIdle } from "./computer-idle.js";
import { performComputerUpdate } from "./computer-update.js";
import type { createRunExecutor } from "./executor.js";
import { compactHistory } from "./history-compaction.js";
import type { MemoryProviderResolver } from "./memory-provider-factory.js";
import { deliverMessagingOutbound, mirrorMessagingOutbound } from "./messaging-delivery.js";
import { createFeedJobHandlers } from "./muse/feed-jobs.js";
import { createGoalJobHandlers } from "./muse/goal-jobs.js";
import { refreshIdeas } from "./muse/ideas.js";
import type { EncryptedSecretStore } from "./secrets.js";
import { expireTaughtSkillTeaching } from "./teaching-session.js";

/** Ideas refresh daily (docs/muse/PLAN.md B11); a Goal status change also enqueues one
 * immediately (see goal-proposals.ts), which this reschedule leaves untouched since the
 * job key is shared and Graphile keeps only the most recently enqueued run time. */
const IDEAS_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function createBackgroundJobHandlers(deps: {
  executor: ReturnType<typeof createRunExecutor>;
  prisma: PrismaClient;
  sandbox: SandboxProvider;
  home: AgentHomeStore;
  jobs: JobPublisher;
  events: ThreadEvents;
  workerId: string;
  runtime: AgentRuntime;
  secretStore: EncryptedSecretStore;
  memoryProviders: MemoryProviderResolver;
  memory: MemoryStore;
  deploymentModelKey?: string;
  messaging?: MessagingSurface;
  cloudAgent?: CloudAgentConnection | null;
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

  const goalJobHandlers = createGoalJobHandlers({
    prisma: deps.prisma,
    jobs: deps.jobs,
    events: deps.events,
    continueRun: (runId, workerId) => deps.executor.continueRun(runId, workerId),
    workerId: deps.workerId,
  });
  const feedJobHandlers = createFeedJobHandlers({
    prisma: deps.prisma,
    jobs: deps.jobs,
    continueRun: (runId, workerId) => deps.executor.continueRun(runId, workerId),
    workerId: deps.workerId,
  });

  return {
    "goal.advance": goalJobHandlers["goal.advance"],
    "goal.checkin": goalJobHandlers["goal.checkin"],
    "feed.topics": feedJobHandlers["feed.topics"],
    "run.continue": async (payload) => {
      await deps.executor.continueRun(payload.runId, deps.workerId);
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
      await deps.executor.wakeRoutine(payload.routineId, payload.scheduledFor);
    },
    "computer.update": async ({ updateId }) => {
      await performComputerUpdate(deps, updateId);
    },
    "computer.sleep": async (payload) => {
      await sleepComputerIfIdle(deps, payload.computerId);
    },
    "computer.control-expire": async (payload) => {
      if (await expireComputerControl(deps, payload.computerId, payload.leaseId)) {
        scheduleComputerSleep(deps.jobs, payload.computerId);
      }
    },
    "skill.teaching-expire": async (payload) => {
      await expireTaughtSkillTeaching(deps, payload.skillId);
    },
    "cloud_agent.poll": async (payload) => {
      await pollCloudAgent(
        {
          prisma: deps.prisma,
          jobs: deps.jobs,
          events: deps.events,
          cloudAgent: deps.cloudAgent,
        },
        payload,
      );
    },
    "history.compact": async (payload) => {
      await compactHistory(
        {
          prisma: deps.prisma,
          runtime: deps.runtime,
          jobs: deps.jobs,
          memoryProviders: deps.memoryProviders,
          deploymentModelKey: deps.deploymentModelKey,
          ...(deps.executor.resolveModel ? { resolveModel: deps.executor.resolveModel } : {}),
        },
        payload.threadId,
      );
    },
    "ideas.refresh": async (payload) => {
      await refreshIdeas(
        {
          prisma: deps.prisma,
          runtime: deps.runtime,
          memory: deps.memory,
          deploymentModelKey: deps.deploymentModelKey,
          ...(deps.executor.resolveModel ? { resolveModel: deps.executor.resolveModel } : {}),
        },
        payload.botId,
      );
      await deps.jobs
        .enqueue(ideasRefreshJob(payload.botId, new Date(Date.now() + IDEAS_REFRESH_INTERVAL_MS)))
        .catch((error) => getLogger().error("ideas.refresh reschedule error", error));
    },
  };
}
