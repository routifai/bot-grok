// `feed.list` posts and `topics.*` for Muses whose proactive work the engine owns
// (docs/adr/0005-proactive-work-is-scheduled-helper-runs.md). The engine serves the followed
// topics (`GET /v1/me/topics`) and what they found (`GET /v1/me/feed`, ADR 0009), and decides
// when a run had nothing new. Following is a scheduled Helper task marked `followed_topic`.
// Nova keeps no Post or FollowedTopic rows for these Muses.
import {
  createOmnigentScheduledTask,
  deleteOmnigentScheduledTask,
  listOmnigentFeed,
  listOmnigentTopics,
  type OmnigentClientConfig,
  type OmnigentTopic,
} from "@aiden/adapters";
import type { Actor, FollowedTopic, Post } from "@aiden/contracts";
import type { PrismaClient } from "@aiden/db";
import { ORPCError } from "@orpc/server";

const WEEKLY = "FREQ=WEEKLY";
const FEED_LIMIT = 20;
/** The engine's marker for a followed topic's scheduled task. */
const FOLLOWED_TOPIC_KIND = "followed_topic";
/** The Helper type a followed topic's runs use. */
const TOPIC_HELPER = "worker";

export interface EngineFeedDeps {
  prisma: PrismaClient;
}

interface Target {
  client: OmnigentClientConfig;
  email: string;
  sessionId: string;
}

const iso = (epochSeconds: number) => new Date(epochSeconds * 1000).toISOString();

async function email(deps: EngineFeedDeps, actor: Actor): Promise<string> {
  const user = await deps.prisma.user.findUnique({
    where: { id: actor.userId },
    select: { email: true },
  });
  if (!user) throw new ORPCError("NOT_FOUND", { message: "Person not found" });
  return user.email;
}

/** The Muse's Super Chat; the bot must be the actor's own. `null` while it has no Conversation. */
async function resolve(
  deps: EngineFeedDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  botId: string,
): Promise<Target | null> {
  const [bot, address, session] = await Promise.all([
    deps.prisma.bot.findFirst({
      where: { id: botId, spaceId: actor.spaceId, userId: actor.userId },
      select: { id: true },
    }),
    email(deps, actor),
    deps.prisma.omnigentSession.findUnique({
      where: { botId },
      select: { omnigentSessionId: true },
    }),
  ]);
  if (!bot) throw new ORPCError("NOT_FOUND", { message: "Muse not found" });
  return session ? { client, email: address, sessionId: session.omnigentSessionId } : null;
}

/** This Muse's followed topics (the engine lists every topic the person follows). */
async function topicsOf(target: Target): Promise<OmnigentTopic[]> {
  const topics = await listOmnigentTopics(target.client, target.email);
  return topics.filter((topic) => topic.session_id === target.sessionId);
}

const toTopic = (topic: OmnigentTopic): FollowedTopic => ({
  id: topic.id,
  topic: topic.name,
  createdAt: iso(topic.created_at ?? 0),
  ...(topic.cadence ? { cadence: topic.cadence } : {}),
});

export async function engineListFeedPosts(
  deps: EngineFeedDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  input: { botId: string; cursor?: string },
): Promise<{ posts: Post[]; nextCursor: string | null }> {
  const target = await resolve(deps, client, actor, input.botId);
  if (!target) return { posts: [], nextCursor: null };
  const [topics, page] = await Promise.all([
    topicsOf(target),
    listOmnigentFeed(client, target.email, { limit: FEED_LIMIT, before: input.cursor }),
  ]);
  const names = new Map(topics.map((topic) => [topic.id, topic.name]));
  const posts: Post[] = page.data.flatMap((post) => {
    const title = names.get(post.topic_id);
    if (title === undefined || !post.text.trim()) return [];
    return [
      {
        id: post.id,
        kind: "topic",
        title,
        body: post.text,
        goalId: null,
        sourceUrl: null,
        createdAt: iso(post.created_at),
      },
    ];
  });
  return { posts, nextCursor: page.has_more ? page.next_cursor : null };
}

export async function engineListTopics(
  deps: EngineFeedDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  botId: string,
): Promise<FollowedTopic[]> {
  const target = await resolve(deps, client, actor, botId);
  return target ? (await topicsOf(target)).map(toTopic) : [];
}

export async function engineFollowTopic(
  deps: EngineFeedDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  input: { botId: string; topic: string },
): Promise<FollowedTopic> {
  const target = await resolve(deps, client, actor, input.botId);
  if (!target) {
    throw new ORPCError("NOT_FOUND", { message: "This Muse has no Conversation yet" });
  }
  const topic = input.topic.trim();
  const existing = (await topicsOf(target)).find(
    (candidate) => candidate.name.toLowerCase() === topic.toLowerCase(),
  );
  if (existing) return toTopic(existing);
  const task = await createOmnigentScheduledTask(client, target.email, {
    name: topic,
    // The engine reads exactly "Nothing new." as a run with nothing to show.
    prompt:
      `Keep up with "${topic}": find what is new since the last run. ` +
      'End with a short card, or exactly "Nothing new." if nothing is new.',
    rrule: WEEKLY,
    parentSessionId: target.sessionId,
    agentType: TOPIC_HELPER,
    kind: FOLLOWED_TOPIC_KIND,
  });
  return {
    id: task.id,
    topic: task.name,
    createdAt: iso(task.created_at ?? 0),
    cadence: "weekly",
  };
}

/** Unfollow: the topic must be one this person follows under one of their own Super Chats. */
export async function engineRemoveTopic(
  deps: EngineFeedDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  topicId: string,
): Promise<{ ok: true }> {
  const address = await email(deps, actor);
  const topic = (await listOmnigentTopics(client, address)).find((item) => item.id === topicId);
  const owned = topic?.session_id
    ? await deps.prisma.omnigentSession.findFirst({
        where: {
          omnigentSessionId: topic.session_id,
          bot: { spaceId: actor.spaceId, userId: actor.userId },
        },
        select: { botId: true },
      })
    : null;
  if (!owned) throw new ORPCError("NOT_FOUND", { message: "Topic not found" });
  await deleteOmnigentScheduledTask(client, address, topicId);
  return { ok: true as const };
}
