import type { Actor, FollowedTopic, Post } from "@nova/contracts";
import {
  createPostRepos,
  createRepos,
  createTopicRepos,
  IsolationError,
  type PrismaClient,
} from "@nova/db";

// B10 · Posts and Followed topics (docs/muse/PLAN.md). Real feed.list posts and
// topics.list/follow/remove. Authorized the same way every other bot-scoped route is:
// `createRepos(prisma).getBot` throws unless `botId` is one of this actor's own bots in
// their own Space (mirrors muse-asks.ts / muse-ideas.ts).

export interface MuseFeedDeps {
  prisma: PrismaClient;
}

export async function listFeedPosts(
  deps: MuseFeedDeps,
  actor: Actor,
  input: { botId: string; cursor?: string },
): Promise<{ posts: Post[]; nextCursor: string | null }> {
  await createRepos(deps.prisma).getBot(actor, input.botId);
  return createPostRepos(deps.prisma).listPosts(input.botId, input.cursor);
}

export async function listTopics(
  deps: MuseFeedDeps,
  actor: Actor,
  botId: string,
): Promise<FollowedTopic[]> {
  await createRepos(deps.prisma).getBot(actor, botId);
  return createTopicRepos(deps.prisma).listTopics(botId);
}

export async function followTopic(
  deps: MuseFeedDeps,
  actor: Actor,
  input: { botId: string; topic: string },
): Promise<FollowedTopic> {
  await createRepos(deps.prisma).getBot(actor, input.botId);
  const topic = input.topic.trim();
  const topics = createTopicRepos(deps.prisma);
  const followed = await topics.followTopic(
    { spaceId: actor.spaceId, userId: actor.userId, botId: input.botId },
    topic,
  );
  return followed;
}

/** The topic's own bot must belong to the actor, like every other bot-scoped route. */
export async function removeTopic(
  deps: MuseFeedDeps,
  actor: Actor,
  topicId: string,
): Promise<{ ok: true }> {
  const topics = createTopicRepos(deps.prisma);
  const topic = await topics.getTopic(topicId);
  if (!topic) throw new IsolationError();
  await createRepos(deps.prisma).getBot(actor, topic.botId);
  await topics.removeTopic(topicId);
  return { ok: true as const };
}
