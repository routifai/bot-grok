// Episodic memory writer: after a finished Muse turn, record one Episode row so it can be
// recalled later (packages/core/src/muse/episodes.ts has the pure build/rank/render
// logic; packages/adapters/src/executor/run-executor.ts wires this in and loads recall
// context).

import { buildEpisode, rankEpisodes } from "@aiden/core";
import type { PrismaClient } from "@aiden/db";
import { WORK_TOOLS } from "./skill-offer-followup.js";

const NO_RESPONSE = "NO_RESPONSE";

export type RecordEpisodeDeps = { prisma: PrismaClient };

export interface RecordEpisodeRun {
  id: string;
  spaceId: string;
  userId: string;
  botId: string;
  threadId: string;
  goalId?: string | null;
  trigger: string;
}

/**
 * After a finished turn, write one Episode row for it. Only recorded when the turn used
 * at least one work tool (`WORK_TOOLS`, ./skill-offer-followup.ts — same event query
 * pattern as `queueSkillOfferFollowUp`) and the reply is a real, non-empty reply (not
 * `NO_RESPONSE`). No model call, so this never adds LLM requests. Upserts by `runId` so a
 * resumed run cannot create a duplicate episode. Returns whether an episode was written.
 */
export async function recordEpisode(
  deps: RecordEpisodeDeps,
  run: RecordEpisodeRun,
  turn: { request: string; reply: string },
): Promise<boolean> {
  const reply = turn.reply.trim();
  if (!reply || reply === NO_RESPONSE) return false;

  const events = await deps.prisma.event.findMany({
    where: { runId: run.id, type: "agent.tool.completed" },
    select: { payload: true },
  });
  const names = events
    .map((event) => (event.payload as { name?: unknown } | null)?.name)
    .filter((name): name is string => typeof name === "string");
  if (!names.some((name) => WORK_TOOLS.has(name))) return false;

  const built = buildEpisode({ request: turn.request, reply, tools: names });
  await deps.prisma.episode.upsert({
    where: { runId: run.id },
    create: {
      spaceId: run.spaceId,
      userId: run.userId,
      botId: run.botId,
      runId: run.id,
      threadId: run.threadId,
      goalId: run.goalId ?? null,
      trigger: run.trigger,
      title: built.title,
      summary: built.summary,
      tools: built.tools,
      links: built.links,
    },
    update: {
      title: built.title,
      summary: built.summary,
      tools: built.tools,
      links: built.links,
    },
  });
  return true;
}

/** How many of the bot's most recent episodes `recall_episodes` searches over. */
const RECALL_EPISODES_LOOKBACK = 1000;
const RECALL_EPISODES_DEFAULT_LIMIT = 5;
const RECALL_EPISODES_MIN_LIMIT = 1;
const RECALL_EPISODES_MAX_LIMIT = 10;

export type RecallEpisodesDeps = { prisma: PrismaClient };
export type RecallEpisodesScope = { botId: string };

export interface RecallEpisodeItem {
  date: string;
  title: string;
  summary: string;
  links: string[];
}

/**
 * `recall_episodes` tool: keyword-ranks the bot's most recent episodes against `query`
 * (packages/core/src/muse/episodes.ts `rankEpisodes`) and returns the top matches. When
 * nothing matches, falls back to the most recent episodes with a note, so the tool never
 * comes back empty when the person clearly did work with this Muse before.
 */
export async function recallEpisodesFromTool(
  deps: RecallEpisodesDeps,
  scope: RecallEpisodesScope,
  input: { query?: string; limit?: number },
): Promise<Record<string, unknown>> {
  const query = String(input.query ?? "").trim();
  const limit = clampRecallLimit(input.limit);

  const episodes = await deps.prisma.episode.findMany({
    where: { botId: scope.botId },
    orderBy: { createdAt: "desc" },
    take: RECALL_EPISODES_LOOKBACK,
    select: { title: true, summary: true, links: true, createdAt: true },
  });

  const ranked = query ? rankEpisodes(query, episodes, { limit }) : [];
  if (ranked.length > 0) {
    return { episodes: ranked.map(toRecallEpisodeItem) };
  }

  const recent = episodes.slice(0, RECALL_EPISODES_DEFAULT_LIMIT);
  return {
    episodes: recent.map(toRecallEpisodeItem),
    note:
      recent.length > 0
        ? "No episodes matched that query; showing the most recent instead."
        : "No past episodes yet.",
  };
}

function clampRecallLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return RECALL_EPISODES_DEFAULT_LIMIT;
  return Math.min(
    RECALL_EPISODES_MAX_LIMIT,
    Math.max(RECALL_EPISODES_MIN_LIMIT, Math.round(limit)),
  );
}

function toRecallEpisodeItem(episode: {
  title: string;
  summary: string;
  links: string[];
  createdAt: Date;
}): RecallEpisodeItem {
  return {
    date: episode.createdAt.toISOString().slice(0, 10),
    title: episode.title,
    summary: episode.summary,
    links: episode.links,
  };
}
