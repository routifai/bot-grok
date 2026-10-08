// Routine wakeup: turns a due Routine into a queued run in its thread (run.continue then
// runs it on the engine). Extracted from the retired Pi executor.
import type { JobPublisher } from "@nova/adapter-kit";
import { routineJobKey, routineWakeupJob, runContinueJob } from "@nova/adapter-kit";
import {
  expandSkillReferencesInPrompt,
  isOneShotRoutineCrons,
  nextCronDateAcross,
} from "@nova/core";
import type { PrismaClient, ThreadEvents } from "@nova/db";
import { deferFutureRoutine } from "./routine-scheduling.js";
import { listAgentSkillRecords } from "./skill-tools.js";

export async function wakeRoutine(
  deps: { prisma: PrismaClient; jobs: JobPublisher; events: ThreadEvents },
  routineId: string,
  scheduledFor: string,
): Promise<void> {
  const scheduledAt = new Date(scheduledFor);
  if (!Number.isFinite(scheduledAt.getTime())) return;
  const routine = await deps.prisma.routine.findUnique({ where: { id: routineId } });
  if (!routine?.active || routine.nextRunAt?.getTime() !== scheduledAt.getTime()) return;
  if (await deferFutureRoutine(deps.jobs, routineId, scheduledAt)) return;
  const bot = await deps.prisma.bot.findUnique({
    where: { id: routine.botId },
    include: { thread: true },
  });
  if (!bot?.thread) return;
  const targetThread = routine.threadId
    ? await deps.prisma.thread.findFirst({
        where: {
          id: routine.threadId,
          spaceId: routine.spaceId,
          OR: [
            { botId: bot.id },
            {
              group: {
                archivedAt: null,
                members: { some: { botId: bot.id } },
              },
            },
          ],
        },
        select: { id: true },
      })
    : null;
  const thread = targetThread ?? bot.thread;
  // A schedule with no valid parseable cron among its crons (e.g. a
  // legacy row accepted before cron validation was added) fires the
  // already-due run once, then nextRunAt stays null and the routine
  // pauses rather than crash-looping the wakeup job.
  const nextRunAt = isOneShotRoutineCrons(routine.crons)
    ? null
    : nextCronDateAcross(
        routine.crons,
        new Date(Math.max(Date.now(), scheduledAt.getTime())),
        routine.timezone,
      );
  const previousLastRunAt = routine.lastRunAt;
  const skillRecords = await listAgentSkillRecords(deps.prisma, {
    spaceId: routine.spaceId,
    userId: routine.userId,
  });
  const routinePrompt = expandSkillReferencesInPrompt(routine.prompt, skillRecords);
  const claimed = await deps.prisma.$transaction(async (tx) => {
    const updated = await tx.routine.updateMany({
      where: { id: routine.id, active: true, nextRunAt: scheduledAt },
      data: {
        lastRunAt: new Date(),
        nextRunAt,
        ...(nextRunAt ? {} : { active: false }),
      },
    });
    if (updated.count !== 1) return null;
    const task = await tx.task.create({
      data: {
        spaceId: routine.spaceId,
        botId: bot.id,
        threadId: thread.id,
        userId: routine.userId,
        prompt: routinePrompt,
        status: "queued",
      },
    });
    return tx.run.create({
      data: {
        spaceId: routine.spaceId,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        userId: routine.userId,
        status: "queued",
        trigger: "routine",
        routineId: routine.id,
      },
    });
  });
  if (!claimed) return;
  // Enqueue continuation first so a thread-signal failure cannot strand the run.
  try {
    await deps.jobs.enqueue(runContinueJob(claimed.id));
  } catch (error) {
    // Restore the claim so wakeup retry / routine reconciliation can fire again.
    await deps.prisma.$transaction(async (tx) => {
      await tx.run.deleteMany({ where: { id: claimed.id, status: "queued" } });
      await tx.task.deleteMany({ where: { id: claimed.taskId, status: "queued" } });
      await tx.routine.updateMany({
        where: {
          id: routine.id,
          nextRunAt,
          ...(nextRunAt ? {} : { active: false }),
        },
        data: {
          nextRunAt: scheduledAt,
          active: true,
          lastRunAt: previousLastRunAt,
        },
      });
    });
    throw error;
  }
  try {
    await deps.events.append({
      spaceId: routine.spaceId,
      threadId: thread.id,
      botId: bot.id,
      type: "routine.fired",
      runId: claimed.id,
      payload: { routineId: routine.id, scheduledFor },
    });
  } catch {
    // Best effort: the run is already queued.
  }
  if (isOneShotRoutineCrons(routine.crons)) {
    try {
      await deps.jobs.cancel(routineJobKey(routine.id));
    } catch {
      // Best effort: the run is already queued for continuation.
    }
  } else if (nextRunAt) {
    await deps.jobs.enqueue(routineWakeupJob(routine.id, nextRunAt));
  }
}
