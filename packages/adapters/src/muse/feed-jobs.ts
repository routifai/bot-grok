// The daily Followed-topic research digest (CONTEXT.md "Followed topic", "Post";
// docs/muse/PLAN.md B10). One job, `feed.topics {botId}`: for every topic the person
// asked the Muse to follow, run a Muse turn that researches it with the same web tools
// (web_search / web_fetch) the Conversation and Goal work already have, writing 1-3
// `topic` Posts (via the `feed_add_topic_post` tool, feed-tools.ts) with a real source
// URL each.
//
// Design choice: reuse the run engine (a real Task + Run, `continueRun`), the same way
// `goal.advance` does (goal-jobs.ts), rather than a one-shot model completion like
// `ideas.refresh` (ideas.ts). A one-shot completion has no tools — it cannot actually
// browse the web, so it could only hallucinate findings and source URLs. One turn
// covering every Followed topic (instead of one turn per topic) keeps the job simple —
// one Task/Run/continueRun call per `feed.topics` firing — while the turn itself can
// still call web_search/web_fetch and `feed_add_topic_post` as many times as it needs,
// once per topic worth reporting on.
//
// Every run's own history accumulates in the Muse's own Feed-log thread (reused across
// firings the same way a Goal log is, `Thread.feedLogBotId` / `Bot.feedLog`), so the
// model can see what it already reported and avoid repeating itself.
import {
  type BackgroundJobHandlers,
  feedTopicsJob,
  feedTopicsJobKey,
  type JobPublisher,
} from "@aiden/adapter-kit";
import type { MuseSettings } from "@aiden/contracts";
import { inQuietHours, quietHoursEnd, resolveMuseSettings } from "@aiden/core";
import { createTopicRepos, type PrismaClient } from "@aiden/db";
import { renderFeedTopicsTaskPrompt } from "./feed-prompts.js";
import { CONVERSATION_DEFER_MS, hasActiveRun } from "./goal-jobs.js";

/** Daily cadence, independent of the Muse's proactivity level (which only gates the
 * digest on/off, same as Goal work) — see docs/muse/PLAN.md B10. */
export const FEED_TOPICS_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * No per-bot timezone exists yet (unlike `Goal.timezone` / `Routine.timezone`): quiet
 * hours for this per-Muse digest are evaluated in UTC, the same default those models
 * fall back to when unset.
 */
const FEED_TIMEZONE = "UTC";

export interface FeedJobDeps {
  prisma: PrismaClient;
  jobs: JobPublisher;
  /** The run engine's continueRun (packages/adapters/src/executor/run-executor.ts). */
  continueRun: (runId: string, workerId: string) => Promise<void>;
  workerId: string;
}

/** Enqueues (or re-enqueues, by the same replaceKey) this Muse's next `feed.topics`. */
export async function scheduleFeedTopics(
  jobs: JobPublisher,
  botId: string,
  at: Date,
): Promise<void> {
  await jobs.enqueue(feedTopicsJob(botId, at));
}

/** When the digest should next fire, or `null` when proactivity is `off`. Mirrors
 * `nextWorkAt` (packages/core/src/muse/proactivity.ts) but with a fixed daily interval
 * instead of one scaled by proactivity level. */
export function nextFeedTopicsAt(
  settings: Pick<MuseSettings, "proactivity" | "quietHours">,
  now: Date,
  timezone: string,
): Date | null {
  if (settings.proactivity === "off") return null;
  let candidate = new Date(now.getTime() + FEED_TOPICS_INTERVAL_MS);
  const quietEnd = inQuietHours(settings.quietHours, candidate, timezone)
    ? quietHoursEnd(settings.quietHours, candidate, timezone)
    : null;
  if (quietEnd) candidate = quietEnd;
  return candidate;
}

/**
 * Re-derives one Muse's `feed.topics` schedule from its current proactivity/quiet-hours
 * settings: cancels it when proactivity is now `off`, else (re)schedules the next
 * firing. Call this after `muse.updateSettings` changes them (apps/api/src/router.ts,
 * alongside `rescheduleMuseGoalsForBot`) and the first time a topic is followed
 * (apps/api/src/muse-feed.ts, feed-tools.ts) so the digest starts without waiting a
 * full day.
 */
export async function rescheduleMuseFeedForBot(
  deps: { prisma: Pick<PrismaClient, "bot">; jobs: JobPublisher },
  botId: string,
): Promise<void> {
  const bot = await deps.prisma.bot.findUnique({
    where: { id: botId },
    select: { museProactivity: true, museQuietHours: true },
  });
  if (!bot) return;
  const settings = resolveMuseSettings(bot);
  if (settings.proactivity === "off") {
    await deps.jobs.cancel(feedTopicsJobKey(botId)).catch(() => undefined);
    return;
  }
  const next = nextFeedTopicsAt(settings, new Date(), FEED_TIMEZONE);
  if (next) await scheduleFeedTopics(deps.jobs, botId, next);
}

/**
 * Schedules the Muse's first `feed.topics` firing the moment it gets its first Followed
 * topic (mirrors `scheduleFirstGoalWork`, goal-tools.ts): before that, an empty topic
 * list never had a reason to schedule the digest. Called from both the `follow_topic`
 * tool (feed-tools.ts) and the `topics.follow` RPC (apps/api/src/muse-feed.ts). Never
 * throws — scheduling failures never block the follow itself.
 */
export async function scheduleFeedDigestOnFirstTopic(
  deps: { prisma: Pick<PrismaClient, "bot">; jobs: JobPublisher },
  botId: string,
  topicCount: number,
): Promise<void> {
  if (topicCount !== 1) return; // Already had at least one: already scheduled.
  await rescheduleMuseFeedForBot(deps, botId).catch(() => undefined);
}

async function handleFeedTopics(deps: FeedJobDeps, payload: { botId: string }): Promise<void> {
  const bot = await deps.prisma.bot.findUnique({
    where: { id: payload.botId },
    include: { thread: true, feedLog: true },
  });
  if (!bot) return; // The Muse no longer exists.

  const settings = resolveMuseSettings(bot);
  if (settings.proactivity === "off") return; // Resumes via rescheduleMuseFeedForBot when turned back on.

  const now = new Date();
  if (inQuietHours(settings.quietHours, now, FEED_TIMEZONE)) {
    const end = quietHoursEnd(settings.quietHours, now, FEED_TIMEZONE);
    if (end) await scheduleFeedTopics(deps.jobs, bot.id, end);
    return;
  }

  const conversationThreadId = bot.thread?.id;
  if (conversationThreadId && (await hasActiveRun(deps.prisma, conversationThreadId))) {
    // Decision 8: the Conversation always goes first.
    await scheduleFeedTopics(deps.jobs, bot.id, new Date(now.getTime() + CONVERSATION_DEFER_MS));
    return;
  }

  const topics = await createTopicRepos(deps.prisma).listTopics(bot.id);
  if (topics.length > 0) {
    const feedLog =
      bot.feedLog ??
      (await deps.prisma.thread.create({
        data: { spaceId: bot.spaceId, userId: bot.userId, feedLogBotId: bot.id },
      }));

    const task = await deps.prisma.task.create({
      data: {
        spaceId: bot.spaceId,
        botId: bot.id,
        threadId: feedLog.id,
        userId: bot.userId,
        prompt: renderFeedTopicsTaskPrompt(topics),
        status: "queued",
      },
    });
    const run = await deps.prisma.run.create({
      data: {
        spaceId: bot.spaceId,
        botId: bot.id,
        threadId: feedLog.id,
        taskId: task.id,
        userId: bot.userId,
        status: "queued",
        trigger: "feed_topics",
      },
    });
    await deps.continueRun(run.id, deps.workerId);
  }

  const next = nextFeedTopicsAt(settings, now, FEED_TIMEZONE);
  if (next) await scheduleFeedTopics(deps.jobs, bot.id, next);
}

/** Registers `feed.topics` (docs/muse/PLAN.md B10, muse mode only). */
export function createFeedJobHandlers(
  deps: FeedJobDeps,
): Pick<BackgroundJobHandlers, "feed.topics"> {
  return {
    "feed.topics": (payload) => handleFeedTopics(deps, payload),
  };
}
