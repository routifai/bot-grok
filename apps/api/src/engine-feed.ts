// `feed.list` posts and `topics.*` for Muses whose proactive work the engine owns
// (docs/adr/0005-proactive-work-is-scheduled-helper-runs.md). A Followed topic is a scheduled
// task on the engine parented on the Muse's Super Chat with agent_type "worker"; a Post is
// one finished run's Result. Nova keeps no Post or FollowedTopic rows for these Muses.
import {
  createOmnigentScheduledTask,
  deleteOmnigentScheduledTask,
  getOmnigentScheduledTask,
  listOmnigentScheduledTaskRuns,
  listOmnigentScheduledTasks,
  listOmnigentSessionItems,
  mapOmnigentItemsToMessages,
  type OmnigentClientConfig,
  type OmnigentScheduledTask,
  redactThreadMessages,
} from "@aiden/adapters";
import type { Actor, FollowedTopic, Post } from "@aiden/contracts";
import type { PrismaClient } from "@aiden/db";
import { ORPCError } from "@orpc/server";

export const FOLLOWED_TOPIC_AGENT_TYPE = "worker";
const WEEKLY = "FREQ=WEEKLY";
/** A run whose whole Result is this has nothing to show. */
const NOTHING_NEW = "Nothing new.";
const FEED_LIMIT = 20;
const RUNS_PER_TOPIC = 5;

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

async function followedTasks(target: Target): Promise<OmnigentScheduledTask[]> {
  const tasks = await listOmnigentScheduledTasks(target.client, target.email, target.sessionId);
  return tasks.filter(
    (task) =>
      task.parent_session_id === target.sessionId && task.agent_type === FOLLOWED_TOPIC_AGENT_TYPE,
  );
}

const CADENCES: Record<string, NonNullable<FollowedTopic["cadence"]>> = {
  HOURLY: "hourly",
  DAILY: "daily",
  WEEKLY: "weekly",
};

/** Cadence from the task's RRULE frequency; unknown frequencies are left out. */
const cadenceOf = (rrule: string): FollowedTopic["cadence"] =>
  CADENCES[/(?:^|;)FREQ=([A-Z]+)/i.exec(rrule)?.[1]?.toUpperCase() ?? ""];

const toTopic = (task: OmnigentScheduledTask): FollowedTopic => {
  const cadence = cadenceOf(task.rrule);
  return {
    id: task.id,
    topic: task.name,
    createdAt: iso(task.created_at ?? 0),
    ...(cadence ? { cadence } : {}),
  };
};

/** The run session's final assistant message, or `null` when there is none. */
async function resultOf(target: Target, sessionId: string): Promise<string | null> {
  const page = await listOmnigentSessionItems(target.client, target.email, sessionId, {
    order: "desc",
    limit: 20,
  });
  const messages = redactThreadMessages(
    mapOmnigentItemsToMessages(sessionId, [...page.data].reverse()),
    target.client.secrets ?? [],
  );
  const last = messages.findLast((message) => message.role === "bot");
  const block = last?.blocks.find((b) => b.kind === "text");
  return block?.kind === "text" ? block.text : null;
}

async function postsOf(target: Target, task: OmnigentScheduledTask): Promise<Post[]> {
  const runs = await listOmnigentScheduledTaskRuns(
    target.client,
    target.email,
    task.id,
    RUNS_PER_TOPIC,
  );
  const posts = await Promise.all(
    runs
      .filter((run) => run.status === "succeeded" && run.conversation_id)
      .map(async (run): Promise<Post | null> => {
        const body = await resultOf(target, run.conversation_id as string);
        if (!body || body.trim() === NOTHING_NEW) return null;
        return {
          id: run.id,
          kind: "topic",
          title: task.name,
          body,
          goalId: null,
          sourceUrl: null,
          createdAt: iso(run.finished_at ?? run.fired_at ?? run.scheduled_at),
        };
      }),
  );
  return posts.filter((post): post is Post => post !== null);
}

export async function engineListFeedPosts(
  deps: EngineFeedDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  botId: string,
): Promise<{ posts: Post[]; nextCursor: null }> {
  const target = await resolve(deps, client, actor, botId);
  if (!target) return { posts: [], nextCursor: null };
  const tasks = await followedTasks(target);
  const posts = (await Promise.all(tasks.map((task) => postsOf(target, task)))).flat();
  posts.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { posts: posts.slice(0, FEED_LIMIT), nextCursor: null };
}

export async function engineListTopics(
  deps: EngineFeedDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  botId: string,
): Promise<FollowedTopic[]> {
  const target = await resolve(deps, client, actor, botId);
  return target ? (await followedTasks(target)).map(toTopic) : [];
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
  const existing = (await followedTasks(target)).find(
    (task) => task.name.toLowerCase() === topic.toLowerCase(),
  );
  if (existing) return toTopic(existing);
  const task = await createOmnigentScheduledTask(client, target.email, {
    name: topic,
    prompt:
      `Keep up with "${topic}": find what is new since the last run. ` +
      `End with a short card, or exactly "${NOTHING_NEW}" if nothing is new.`,
    rrule: WEEKLY,
    parentSessionId: target.sessionId,
    agentType: FOLLOWED_TOPIC_AGENT_TYPE,
  });
  return toTopic(task);
}

/** Unfollow: the task must be a followed topic of one of the actor's own Super Chats. */
export async function engineRemoveTopic(
  deps: EngineFeedDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  topicId: string,
): Promise<{ ok: true }> {
  const address = await email(deps, actor);
  const task = await getOmnigentScheduledTask(client, address, topicId).catch(() => null);
  const owned =
    task?.parent_session_id && task.agent_type === FOLLOWED_TOPIC_AGENT_TYPE
      ? await deps.prisma.omnigentSession.findFirst({
          where: {
            omnigentSessionId: task.parent_session_id,
            bot: { spaceId: actor.spaceId, userId: actor.userId },
          },
          select: { botId: true },
        })
      : null;
  if (!owned) throw new ORPCError("NOT_FOUND", { message: "Topic not found" });
  await deleteOmnigentScheduledTask(client, address, topicId);
  return { ok: true as const };
}
