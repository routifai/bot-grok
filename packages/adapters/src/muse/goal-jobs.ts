// Background Goal work (CONTEXT.md "Goal", "Goal log", "Check-in", "Proactivity";
// docs/muse/PLAN.md B8). Adapted from OpenMuse (MIT) — openmuse/server/service.py's
// background-pass scheduling (interval, quiet hours, one pass at a time) — and from
// packages/adapters/src/executor/run-executor.ts's wakeRoutine (how a scheduled job turns
// into a run in a thread).
//
// Two jobs:
//   - `goal.advance` works the next pending Task(s) in a Goal's own log thread, then
//     reports back to the Conversation.
//   - `goal.checkin` reaches out about a Goal on its own schedule, directly in the
//     Conversation, without doing any work.
// Both share one Graphile queueName per Muse (`museQueueName`) so at most one runs at a
// time (CONTEXT.md: "The Muse works on at most one Goal at a time"), and both step aside
// for the Conversation (decision 8) when it has a run in flight.
//
// continueRun executes a run to completion (or a pause) in-process and returns, so this
// module calls it directly and reads the result back afterward instead of enqueueing a
// separate run.continue and waiting on some other signal — this keeps the run engine
// itself unchanged (ADR 0002 / R1: Muse logic lives in packages/adapters/src/muse/).
import {
  type BackgroundJobHandlers,
  goalAdvanceJob,
  goalAdvanceJobKey,
  goalCheckinJob,
  goalCheckinJobKey,
  type JobPublisher,
  museQueueName,
} from "@aiden/adapter-kit";
import type { MessageBlock } from "@aiden/contracts";
import {
  ACTIVE_RUN_STATUSES,
  inQuietHours,
  nextCronDateAcross,
  nextWorkAt,
  quietHoursEnd,
  resolveMuseSettings,
} from "@aiden/core";
import {
  appendEventInTransaction,
  createGoalRepos,
  createThreadMessageInTransaction,
  type PrismaClient,
} from "@aiden/db";
import { ADVANCE_GOAL_TASK_PROMPT, renderCheckInTaskPrompt } from "./goal-prompts.js";

/** The Conversation always goes first (decision 8); a busy one defers Goal work by this long. */
const CONVERSATION_DEFER_MS = 60_000;

export interface GoalJobEvents {
  notify(threadId: string, seq: number): Promise<void>;
}

export interface GoalJobDeps {
  prisma: PrismaClient;
  jobs: JobPublisher;
  events: GoalJobEvents;
  /** The run engine's continueRun (packages/adapters/src/executor/run-executor.ts). */
  continueRun: (runId: string, workerId: string) => Promise<void>;
  workerId: string;
}

type LoadedGoal = Awaited<ReturnType<typeof loadGoalWithBot>>;

async function loadGoalWithBot(prisma: PrismaClient, goalId: string) {
  const goal = await prisma.goal.findUnique({ where: { id: goalId }, include: { log: true } });
  if (!goal) return null;
  const bot = await prisma.bot.findUnique({
    where: { id: goal.botId },
    include: { thread: true },
  });
  if (!bot) return null;
  return { goal, bot };
}

async function hasActiveRun(prisma: PrismaClient, threadId: string): Promise<boolean> {
  const run = await prisma.run.findFirst({
    where: { threadId, status: { in: [...ACTIVE_RUN_STATUSES] } },
    select: { id: true },
  });
  return Boolean(run);
}

/** Enqueues (or re-enqueues, by the same replaceKey) this Goal's next `goal.advance`. */
export async function scheduleGoalAdvance(
  jobs: JobPublisher,
  goalId: string,
  botId: string,
  at: Date,
): Promise<void> {
  await jobs.enqueue(goalAdvanceJob(goalId, botId, at));
}

/**
 * Computes and enqueues this Goal's next check-in from its crons, or cancels a pending one
 * when it no longer has any (checkInCrons cleared). Same cron helper Routines use
 * (`nextCronDateAcross`, packages/core/src/cron.ts), applied to `Goal.checkInCrons` /
 * `Goal.timezone` (B3) instead of `Routine.crons` / `Routine.timezone`.
 */
export async function scheduleGoalCheckin(
  jobs: JobPublisher,
  goal: { id: string; botId: string; checkInCrons: string[]; timezone: string },
  from: Date,
): Promise<Date | null> {
  const next = nextCronDateAcross(goal.checkInCrons, from, goal.timezone);
  if (next) await jobs.enqueue(goalCheckinJob(goal.id, goal.botId, next));
  else await jobs.cancel(goalCheckinJobKey(goal.id)).catch(() => undefined);
  return next;
}

/**
 * Wakes a Goal now: enqueues `goal.advance` immediately (same replaceKey as any already
 * scheduled advance, so this simply brings it forward). Call this wherever an Ask tied to
 * a Goal is answered — a Proposal accepted (packages/adapters/src/muse/goal-proposals.ts)
 * or a blocked Task answered (B6) — so work resumes right away instead of waiting for the
 * next proactivity tick.
 */
export async function wakeGoal(
  deps: { prisma: Pick<PrismaClient, "goal">; jobs: JobPublisher },
  goalId: string,
): Promise<void> {
  const goal = await deps.prisma.goal.findUnique({
    where: { id: goalId },
    select: { id: true, botId: true },
  });
  if (!goal) return;
  await scheduleGoalAdvance(deps.jobs, goal.id, goal.botId, new Date());
}

/**
 * Re-derives every active Goal's `goal.advance` schedule for one Muse from its current
 * proactivity/quiet-hours settings. Call this after `muse.updateSettings` changes them
 * (apps/api/src/router.ts) so a Goal already waiting for a stale interval reschedules
 * immediately instead of on its next fire.
 */
export async function rescheduleMuseGoalsForBot(
  deps: { prisma: PrismaClient; jobs: JobPublisher },
  botId: string,
): Promise<void> {
  const bot = await deps.prisma.bot.findUnique({
    where: { id: botId },
    select: { museProactivity: true, museQuietHours: true },
  });
  if (!bot) return;
  const settings = resolveMuseSettings(bot);
  const goals = await deps.prisma.goal.findMany({
    where: { botId, status: "active" },
    select: { id: true, lastWorkedAt: true, timezone: true },
  });
  const now = new Date();
  for (const goal of goals) {
    if (settings.proactivity === "off") {
      await deps.jobs.cancel(goalAdvanceJobKey(goal.id)).catch(() => undefined);
      continue;
    }
    const next = nextWorkAt(settings, goal.lastWorkedAt, now, goal.timezone);
    if (next) await scheduleGoalAdvance(deps.jobs, goal.id, botId, next);
  }
}

function textOf(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  return (blocks as MessageBlock[])
    .filter((block): block is Extract<MessageBlock, { kind: "text" }> => block.kind === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

/** The last non-empty bot reply in this run — the advance prompt's required closing report. */
async function extractLatestBotReport(prisma: PrismaClient, runId: string): Promise<string> {
  const messages = await prisma.message.findMany({
    where: { runId, role: "bot" },
    orderBy: { seq: "asc" },
    select: { blocks: true },
  });
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const text = textOf(messages[i]?.blocks);
    if (text) return text;
  }
  return "";
}

/** Posts a plain bot message directly into a thread (no run of its own — see goal-tools.ts's postAskMessage for the same pattern). */
async function postConversationReport(
  deps: GoalJobDeps,
  input: { spaceId: string; botId: string; threadId: string; text: string },
): Promise<void> {
  const notify = await deps.prisma.$transaction(async (tx) => {
    const message = await createThreadMessageInTransaction(tx, {
      threadId: input.threadId,
      role: "bot",
      blocks: [{ kind: "text", text: input.text }],
      botId: input.botId,
    });
    const event = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      type: "thread.message.created",
      payload: { messageId: message.id, role: "bot", blocks: message.blocks },
    });
    return { threadId: event.threadId, seq: event.seq };
  });
  await deps.events.notify(notify.threadId, notify.seq).catch(() => undefined);
}

/**
 * B10 (docs/muse/PLAN.md) adds the Post model; until it lands there is nothing to create
 * here. Feature-detected with a soft cast so this file does not hard-depend on a model
 * that may not exist yet in the generated Prisma client.
 */
async function maybeCreateGoalReportPost(
  prisma: PrismaClient,
  input: { botId: string; goalId: string; body: string },
): Promise<void> {
  if (!input.body) return;
  const client = prisma as unknown as {
    post?: { create: (args: { data: Record<string, unknown> }) => Promise<unknown> };
  };
  if (!client.post) return;
  await client.post.create({
    data: {
      botId: input.botId,
      kind: "goal_report",
      title: "Goal update",
      body: input.body,
      goalId: input.goalId,
    },
  });
}

async function handleGoalAdvance(deps: GoalJobDeps, payload: { goalId: string }): Promise<void> {
  const loaded: LoadedGoal = await loadGoalWithBot(deps.prisma, payload.goalId);
  if (!loaded) return; // Goal (or its Muse) no longer exists.
  const { goal, bot } = loaded;
  if (goal.status !== "active") return; // paused/done/cancelled: nothing to reschedule.

  const settings = resolveMuseSettings(bot);
  if (settings.proactivity === "off") return; // never works on its own.

  const now = new Date();
  if (inQuietHours(settings.quietHours, now, goal.timezone)) {
    const end = quietHoursEnd(settings.quietHours, now, goal.timezone);
    if (end) await scheduleGoalAdvance(deps.jobs, goal.id, bot.id, end);
    return;
  }

  const conversationThreadId = bot.thread?.id;
  if (conversationThreadId && (await hasActiveRun(deps.prisma, conversationThreadId))) {
    // Decision 8: the Conversation always goes first.
    await scheduleGoalAdvance(
      deps.jobs,
      goal.id,
      bot.id,
      new Date(now.getTime() + CONVERSATION_DEFER_MS),
    );
    return;
  }

  const logThread =
    goal.log ??
    (await deps.prisma.thread.create({
      data: { spaceId: goal.spaceId, userId: goal.userId, goalId: goal.id },
    }));

  const task = await deps.prisma.task.create({
    data: {
      spaceId: goal.spaceId,
      botId: bot.id,
      threadId: logThread.id,
      userId: goal.userId,
      prompt: ADVANCE_GOAL_TASK_PROMPT,
      status: "queued",
    },
  });
  const run = await deps.prisma.run.create({
    data: {
      spaceId: goal.spaceId,
      botId: bot.id,
      threadId: logThread.id,
      taskId: task.id,
      userId: goal.userId,
      status: "queued",
      trigger: "goal_advance",
    },
  });

  await deps.continueRun(run.id, deps.workerId);

  const reportText = await extractLatestBotReport(deps.prisma, run.id);
  if (conversationThreadId && reportText) {
    await postConversationReport(deps, {
      spaceId: goal.spaceId,
      botId: bot.id,
      threadId: conversationThreadId,
      text: reportText,
    });
  }
  await maybeCreateGoalReportPost(deps.prisma, {
    botId: bot.id,
    goalId: goal.id,
    body: reportText,
  });

  await deps.prisma.goal.update({ where: { id: goal.id }, data: { lastWorkedAt: now } });
  const next = nextWorkAt(settings, now, now, goal.timezone);
  if (next) await scheduleGoalAdvance(deps.jobs, goal.id, bot.id, next);
}

async function handleGoalCheckin(deps: GoalJobDeps, payload: { goalId: string }): Promise<void> {
  const loaded: LoadedGoal = await loadGoalWithBot(deps.prisma, payload.goalId);
  if (!loaded) return;
  const { goal, bot } = loaded;
  const conversationThread = bot.thread;
  if (!conversationThread) return;

  // Decision 8: the Conversation always goes first, even for a check-in the person
  // scheduled themselves — defer the whole check-in rather than also re-deriving its next
  // cron occurrence here (that happens once this firing actually proceeds, below).
  if (await hasActiveRun(deps.prisma, conversationThread.id)) {
    await deps.jobs.enqueue(
      goalCheckinJob(goal.id, bot.id, new Date(Date.now() + CONVERSATION_DEFER_MS)),
    );
    return;
  }

  // The next occurrence is scheduled regardless of the Goal's status below: a paused Goal
  // still keeps its check-in cadence for whenever it resumes.
  await scheduleGoalCheckin(deps.jobs, goal, new Date());

  if (goal.status !== "active") return; // Check-ins ignore quiet hours (decision 6): the person chose the time.

  const goalRepos = createGoalRepos(deps.prisma);
  const rendered = await goalRepos.getGoal(goal.id);
  if (!rendered) return;

  const task = await deps.prisma.task.create({
    data: {
      spaceId: goal.spaceId,
      botId: bot.id,
      threadId: conversationThread.id,
      userId: goal.userId,
      prompt: renderCheckInTaskPrompt(rendered),
      status: "queued",
    },
  });
  const run = await deps.prisma.run.create({
    data: {
      spaceId: goal.spaceId,
      botId: bot.id,
      threadId: conversationThread.id,
      taskId: task.id,
      userId: goal.userId,
      status: "queued",
      // Reuses the Routine trigger: isolated context and the same silent-reply guidance a
      // scheduled message already gets (packages/adapters/src/executor/run-prompt.ts,
      // run-completion.ts) — a check-in is exactly that shape, just Goal-scheduled instead
      // of cron-on-a-Routine. The run's own completion publishes the reply, so there is no
      // separate report-posting step here (contrast with goal.advance above).
      trigger: "routine",
    },
  });

  await deps.continueRun(run.id, deps.workerId);
}

/** Registers `goal.advance` / `goal.checkin` (docs/muse/PLAN.md B8, muse mode only). */
export function createGoalJobHandlers(
  deps: GoalJobDeps,
): Pick<BackgroundJobHandlers, "goal.advance" | "goal.checkin"> {
  return {
    "goal.advance": (payload) => handleGoalAdvance(deps, payload),
    "goal.checkin": (payload) => handleGoalCheckin(deps, payload),
  };
}

export { museQueueName };
