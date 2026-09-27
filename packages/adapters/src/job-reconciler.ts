import {
  goalAdvanceJob,
  goalCheckinJob,
  type JobPublisher,
  messagingDeliverJob,
  routineWakeupJob,
  runContinueJob,
} from "@aiden/adapter-kit";
import type { MessageBlock } from "@aiden/contracts";
import { nextCronDateAcross } from "@aiden/core";
import type { Pool, PrismaClient, ThreadEvents } from "@aiden/db";
import { getLogger } from "@aiden/logging";
import type { PoolClient } from "pg";
import { returnBotMessageOutcome } from "./bot-messages.js";
import { scheduleComputerControlExpiry } from "./computer-control.js";
import { isUserProgressClientNonce } from "./user-progress.js";

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_BATCH_SIZE = 100;
const ROUTINE_LOOKAHEAD_MS = 60_000;
const CONTROL_LOOKAHEAD_MS = 60_000;
// Muse edition only (docs/muse/PLAN.md B8): same lookahead as Routines above, applied to
// Goal.nextWorkAt.
const GOAL_ADVANCE_LOOKAHEAD_MS = ROUTINE_LOOKAHEAD_MS;
// Two keys give Aiden's lock a namespace without relying on a hash that might collide
// with an application using the one-key advisory-lock API.
const RECONCILIATION_LOCK_NAMESPACE = 1_380_019_075;
const RECONCILIATION_LOCK_ID = 1;

type Cursor = { at: Date; id: string };
type ControlCursor = { at: Date | null; id: string };

export interface ReconciliationLeadership {
  tryAcquire(): Promise<boolean>;
  release(): Promise<void>;
}

/**
 * Holds a session advisory lock for the lifetime of the elected reconciler. Followers
 * retry on every reconciliation interval, so a disconnected or stopped leader is
 * replaced without coordinating through application state.
 */
export function createPostgresReconciliationLeadership(
  pool: Pick<Pool, "connect">,
  options: { lockId?: number } = {},
): ReconciliationLeadership {
  const lockId = options.lockId ?? RECONCILIATION_LOCK_ID;
  let leaderClient: PoolClient | undefined;
  let leaderErrorListener: (() => void) | undefined;

  const loseClient = (client: PoolClient) => {
    if (leaderClient !== client) return;
    leaderClient = undefined;
    leaderErrorListener = undefined;
    client.release(true);
  };

  return {
    async tryAcquire() {
      if (leaderClient) return true;

      const candidate = await pool.connect();
      try {
        const result = await candidate.query<{ acquired: boolean }>(
          "SELECT pg_try_advisory_lock($1::integer, $2::integer) AS acquired",
          [RECONCILIATION_LOCK_NAMESPACE, lockId],
        );
        if (!result.rows[0]?.acquired) {
          candidate.release();
          return false;
        }

        leaderClient = candidate;
        leaderErrorListener = () => loseClient(candidate);
        candidate.once("error", leaderErrorListener);
        return true;
      } catch (error) {
        candidate.release(true);
        throw error;
      }
    },

    async release() {
      const client = leaderClient;
      if (!client) return;
      leaderClient = undefined;
      if (leaderErrorListener) client.removeListener("error", leaderErrorListener);
      leaderErrorListener = undefined;

      let destroy = false;
      try {
        const result = await client.query<{ released: boolean }>(
          "SELECT pg_advisory_unlock($1::integer, $2::integer) AS released",
          [RECONCILIATION_LOCK_NAMESPACE, lockId],
        );
        destroy = result.rows[0]?.released !== true;
      } catch {
        // Never return a connection with an uncertain session lock to the pool.
        destroy = true;
      } finally {
        client.release(destroy);
      }
    },
  };
}

export function createJobReconciler(
  deps: {
    prisma: PrismaClient;
    jobs: JobPublisher;
    events?: ThreadEvents;
    leadership?: ReconciliationLeadership;
    reconcileComputerUpdates?: () => Promise<void>;
    reconcileCloudAgents?: () => Promise<void>;
  },
  options: { intervalMs?: number; batchSize?: number } = {},
) {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  let timer: ReturnType<typeof setInterval> | undefined;
  let reconciling: Promise<void> | undefined;
  let runCursor: Cursor | undefined;
  let routineCursor: Cursor | undefined;
  let controlCursor: ControlCursor | undefined;
  let controlScanDeadline: Date | undefined;
  // Muse edition only (docs/muse/PLAN.md B8): every active Goal always has a pending
  // goal.advance (cursor on nextWorkAt, mirroring routineCursor) and, if it has any check-in
  // crons, a pending goal.checkin (cursor on createdAt — there is no persisted "next
  // check-in" column; scheduleGoalCheckin's replaceKey makes re-enqueuing the freshly
  // recomputed next occurrence every tick idempotent, exactly like routineCursor's re-enqueue
  // of routineWakeupJob above).
  let goalAdvanceCursor: Cursor | undefined;
  let goalCheckinCursor: Cursor | undefined;

  const reconcileOnce = async () => {
    if (reconciling) return reconciling;
    reconciling = (async () => {
      if (deps.leadership && !(await deps.leadership.tryAcquire())) return;

      const auxiliary = await Promise.allSettled(
        [deps.reconcileCloudAgents, deps.reconcileComputerUpdates].map(async (reconcile) =>
          reconcile?.(),
        ),
      );
      for (const result of auxiliary) {
        if (result.status === "rejected")
          getLogger().error("auxiliary reconciliation", result.reason);
      }

      const now = new Date();
      controlScanDeadline ??= new Date(now.getTime() + CONTROL_LOOKAHEAD_MS);
      const runCursorFilter = runCursor
        ? {
            OR: [
              { updatedAt: { gt: runCursor.at } },
              { updatedAt: runCursor.at, id: { gt: runCursor.id } },
            ],
          }
        : undefined;
      const routineCursorFilter = routineCursor
        ? {
            OR: [
              { nextRunAt: { gt: routineCursor.at } },
              { nextRunAt: routineCursor.at, id: { gt: routineCursor.id } },
            ],
          }
        : undefined;
      const controlCursorFilter = controlCursor
        ? controlCursor.at
          ? {
              OR: [
                { controlLeaseExpiresAt: { gt: controlCursor.at } },
                {
                  controlLeaseExpiresAt: controlCursor.at,
                  id: { gt: controlCursor.id },
                },
                { controlLeaseExpiresAt: null },
              ],
            }
          : { controlLeaseExpiresAt: null, id: { gt: controlCursor.id } }
        : undefined;
      const goalAdvanceCursorFilter = goalAdvanceCursor
        ? {
            OR: [
              { nextWorkAt: { gt: goalAdvanceCursor.at } },
              { nextWorkAt: goalAdvanceCursor.at, id: { gt: goalAdvanceCursor.id } },
            ],
          }
        : undefined;
      const goalCheckinCursorFilter = goalCheckinCursor
        ? {
            OR: [
              { createdAt: { gt: goalCheckinCursor.at } },
              { createdAt: goalCheckinCursor.at, id: { gt: goalCheckinCursor.id } },
            ],
          }
        : undefined;
      const [
        runs,
        routines,
        controls,
        dueOutbound,
        unmirroredMessagingRuns,
        goalsNeedingAdvance,
        goalsNeedingCheckin,
      ] = await Promise.all([
        deps.prisma.run.findMany({
          where: {
            AND: [
              {
                OR: [
                  { status: "queued" },
                  {
                    status: { in: ["leased", "running"] },
                    leaseExpiresAt: { lte: now },
                  },
                ],
              },
              ...(runCursorFilter ? [runCursorFilter] : []),
            ],
          },
          orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
          take: batchSize,
          select: { id: true, updatedAt: true },
        }),
        deps.prisma.routine.findMany({
          where: {
            AND: [
              {
                active: true,
                nextRunAt: { lte: new Date(now.getTime() + ROUTINE_LOOKAHEAD_MS) },
              },
              ...(routineCursorFilter ? [routineCursorFilter] : []),
            ],
          },
          orderBy: [{ nextRunAt: "asc" }, { id: "asc" }],
          take: batchSize,
          select: { id: true, nextRunAt: true },
        }),
        deps.prisma.computer.findMany({
          where: {
            AND: [
              { controlLeaseId: { not: null } },
              {
                OR: [
                  { controlLeaseExpiresAt: null },
                  {
                    controlLeaseExpiresAt: {
                      lte: controlScanDeadline,
                    },
                  },
                ],
              },
              ...(controlCursorFilter ? [controlCursorFilter] : []),
            ],
          },
          orderBy: [{ controlLeaseExpiresAt: "asc" }, { id: "asc" }],
          take: batchSize,
          select: {
            id: true,
            controlBotId: true,
            controlLeaseId: true,
            controlLeaseExpiresAt: true,
          },
        }),
        deps.prisma.messagingOutbound.findFirst({
          where: {
            status: "pending",
            OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
          },
          select: { id: true },
        }),
        deps.prisma.run.findMany({
          where: { trigger: "messaging", status: "completed", messagingMirroredAt: null },
          orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
          take: batchSize,
          select: { id: true },
        }),
        // Muse edition only (docs/muse/PLAN.md B8): active Goals whose next advance is due
        // soon. Harmless (and not queried) in aiden mode, where no Goal rows ever exist.
        deps.prisma.goal.findMany({
          where: {
            AND: [
              {
                status: "active",
                nextWorkAt: { lte: new Date(now.getTime() + GOAL_ADVANCE_LOOKAHEAD_MS) },
              },
              ...(goalAdvanceCursorFilter ? [goalAdvanceCursorFilter] : []),
            ],
          },
          orderBy: [{ nextWorkAt: "asc" }, { id: "asc" }],
          take: batchSize,
          select: { id: true, botId: true, nextWorkAt: true },
        }),
        deps.prisma.goal.findMany({
          where: {
            AND: [
              { status: "active", checkInCrons: { isEmpty: false } },
              ...(goalCheckinCursorFilter ? [goalCheckinCursorFilter] : []),
            ],
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: batchSize,
          select: { id: true, botId: true, checkInCrons: true, timezone: true, createdAt: true },
        }),
      ]);

      const events = deps.events;
      if (events) {
        const outcomes = await deps.prisma.run.findMany({
          where: {
            trigger: "bot_message",
            status: { in: ["completed", "failed"] },
            botOutcomeReturnedAt: null,
          },
          orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
          take: batchSize,
          select: {
            id: true,
            spaceId: true,
            threadId: true,
            botId: true,
            userId: true,
            sourceMessageId: true,
            status: true,
            error: true,
            bot: { select: { name: true } },
          },
        });
        await Promise.all(
          outcomes.map(async (run) => {
            const transcript =
              run.status === "failed"
                ? { text: "", progressOnly: false }
                : await botRunOutcomeText(deps.prisma, run.id);
            const text =
              run.status === "failed"
                ? `Could not complete the delegated request: ${run.error ?? "unknown error"}`
                : transcript.text ||
                  "The delegated bot completed its turn without a written summary.";
            // Same stable delivery key as the executor path (auto-outcome:<runId>), so a
            // concurrent or earlier return is replayed instead of double-posted. Progress-only
            // transcripts (all mid-turn user-progress messages) return as status.
            const intent =
              run.status === "failed" || !transcript.text.trim() || transcript.progressOnly
                ? "status"
                : ("result" as const);
            const returned = await returnBotMessageOutcome(
              { prisma: deps.prisma, jobs: deps.jobs, events },
              run,
              { id: run.botId, name: run.bot.name },
              text,
              intent,
            ).catch((error) => {
              getLogger().error("bot message outcome reconciliation", error);
              return false;
            });
            if (!returned) {
              await deps.prisma.run.updateMany({
                where: { id: run.id, botOutcomeReturnedAt: null },
                data: { updatedAt: new Date() },
              });
            }
          }),
        );
      }

      await Promise.all([
        ...runs.map((run) => deps.jobs.enqueue(runContinueJob(run.id))),
        ...routines.flatMap((routine) =>
          routine.nextRunAt
            ? [deps.jobs.enqueue(routineWakeupJob(routine.id, routine.nextRunAt))]
            : [],
        ),
        ...controls.flatMap((computer) =>
          computer.controlLeaseId
            ? [
                scheduleComputerControlExpiry(
                  deps.jobs,
                  computer.id,
                  computer.controlLeaseId,
                  computer.controlLeaseExpiresAt ?? now,
                ),
              ]
            : [],
        ),
        ...(dueOutbound ? [deps.jobs.enqueue(messagingDeliverJob())] : []),
        ...unmirroredMessagingRuns.map((run) => deps.jobs.enqueue(messagingDeliverJob(run.id))),
        ...goalsNeedingAdvance.flatMap((goal) =>
          goal.nextWorkAt
            ? [deps.jobs.enqueue(goalAdvanceJob(goal.id, goal.botId, goal.nextWorkAt))]
            : [],
        ),
        ...goalsNeedingCheckin.flatMap((goal) => {
          const next = nextCronDateAcross(goal.checkInCrons, now, goal.timezone);
          return next ? [deps.jobs.enqueue(goalCheckinJob(goal.id, goal.botId, next))] : [];
        }),
      ]);

      const lastRun = runs.at(-1);
      runCursor =
        runs.length === batchSize && lastRun
          ? { at: lastRun.updatedAt, id: lastRun.id }
          : undefined;
      const lastRoutine = routines.at(-1);
      routineCursor =
        routines.length === batchSize && lastRoutine?.nextRunAt
          ? { at: lastRoutine.nextRunAt, id: lastRoutine.id }
          : undefined;
      const lastControl = controls.at(-1);
      controlCursor =
        controls.length === batchSize && lastControl
          ? { at: lastControl.controlLeaseExpiresAt, id: lastControl.id }
          : undefined;
      if (!controlCursor) controlScanDeadline = undefined;
      const lastGoalAdvance = goalsNeedingAdvance.at(-1);
      goalAdvanceCursor =
        goalsNeedingAdvance.length === batchSize && lastGoalAdvance?.nextWorkAt
          ? { at: lastGoalAdvance.nextWorkAt, id: lastGoalAdvance.id }
          : undefined;
      const lastGoalCheckin = goalsNeedingCheckin.at(-1);
      goalCheckinCursor =
        goalsNeedingCheckin.length === batchSize && lastGoalCheckin
          ? { at: lastGoalCheckin.createdAt, id: lastGoalCheckin.id }
          : undefined;
    })().finally(() => {
      reconciling = undefined;
    });
    return reconciling;
  };
  const reconcileSafely = () => {
    void reconcileOnce().catch((error) =>
      getLogger().error("background job reconciliation", error),
    );
  };

  return {
    reconcileOnce,
    start() {
      if (timer) return;
      reconcileSafely();
      timer = setInterval(reconcileSafely, intervalMs);
      timer.unref?.();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await reconciling?.catch(() => undefined);
      await deps.leadership?.release();
    },
  };
}

/** Prefer the full bot transcript for a run so interim progress is not mistaken for the sole result. */
async function botRunOutcomeText(
  prisma: {
    message: {
      findMany: (args: {
        where: { runId: string; role: "bot" };
        orderBy: { seq: "asc" };
        select: { blocks: true; clientNonce: true };
      }) => Promise<Array<{ blocks: unknown; clientNonce: string | null }>>;
    };
  },
  runId: string,
): Promise<{ text: string; progressOnly: boolean }> {
  const messages = await prisma.message.findMany({
    where: { runId, role: "bot" },
    orderBy: { seq: "asc" },
    select: { blocks: true, clientNonce: true },
  });
  const progressParts: string[] = [];
  const finalParts: string[] = [];
  for (const message of messages) {
    const text = messageText(message.blocks);
    if (!text) continue;
    if (isUserProgressClientNonce(message.clientNonce)) progressParts.push(text);
    else finalParts.push(text);
  }
  // Prefer the latest non-progress reply when present so earlier untagged mid-run
  // publishes (for example pre-takeover narration) do not contaminate the result.
  // Progress-only turns still join progress beats as status.
  if (finalParts.length > 0) {
    return { text: finalParts[finalParts.length - 1]!, progressOnly: false };
  }
  return { text: progressParts.join("\n\n"), progressOnly: progressParts.length > 0 };
}

function messageText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  return (blocks as MessageBlock[])
    .filter((block): block is Extract<MessageBlock, { kind: "text" }> => block.kind === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}
