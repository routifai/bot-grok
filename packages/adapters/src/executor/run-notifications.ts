// Run-level push notifications (finish / approval-needed / failure) and lease renewal.
import type { NotificationMessage } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ExecutorDeps } from "./types.js";

export async function runNotificationsEnabled(
  prisma: PrismaClient,
  run: { spaceId: string; userId: string; botId: string; threadId: string },
): Promise<boolean> {
  const source = await prisma.run.findFirst({
    where: {
      botId: run.botId,
      threadId: run.threadId,
      spaceId: run.spaceId,
      userId: run.userId,
    },
    select: {
      bot: { select: { notifyOnFinish: true } },
      thread: { select: { groupId: true } },
    },
  });
  return Boolean(source && (source.thread.groupId || source.bot.notifyOnFinish));
}

export async function notifyRun(
  deps: ExecutorDeps,
  run: { spaceId: string; userId: string; botId: string; threadId: string },
  message: NotificationMessage,
) {
  if (!deps.notifications) return;
  const enabled = await runNotificationsEnabled(deps.prisma, run).catch((error) => {
    getLogger().error("notification preference lookup", error);
    return false;
  });
  if (!enabled) return;
  await deps.notifications
    .send(message, {
      operationId: "notify",
      traceId: run.botId,
      spaceId: run.spaceId,
      userId: run.userId,
      botId: run.botId,
      signal: new AbortController().signal,
    })
    .catch((error) => {
      getLogger().error("run notification", error);
    });
}

export async function renewRunLease(
  deps: ExecutorDeps,
  runId: string,
  workerId: string,
  fence: number,
): Promise<boolean> {
  const renewed = await deps.prisma.run.updateMany({
    where: { id: runId, status: "running", leaseOwner: workerId, leaseFence: fence },
    data: { leaseExpiresAt: new Date(Date.now() + 5 * 60_000) },
  });
  return renewed.count === 1;
}
