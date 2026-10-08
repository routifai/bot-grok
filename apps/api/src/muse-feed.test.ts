import type { Actor } from "@nova/contracts";
import { IsolationError, type PrismaClient } from "@nova/db";
import { describe, expect, it, vi } from "vitest";
import {
  followTopic,
  listFeedPosts,
  listTopics,
  type MuseFeedDeps,
  removeTopic,
} from "./muse-feed.js";

const actor: Actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@nova.test",
  isDeploymentOwner: true,
};

const BOT_ID = "bot-1";
const OTHER_BOT_ID = "bot-2";

const POST_ROW = {
  id: "post-1",
  kind: "goal_report",
  title: "Chose your Japanese course",
  body: "Compared four options; Genki I fits best.",
  goalId: "goal-1",
  sourceUrl: null,
  artifactId: null,
  createdAt: new Date("2026-09-27T02:00:00.000Z"),
};

const TOPIC_ROW = {
  id: "topic-1",
  topic: "AI agent news",
  botId: BOT_ID,
  createdAt: new Date("2026-09-20T00:00:00.000Z"),
};

function fakeDeps(
  options: { postRows?: (typeof POST_ROW)[]; topicRows?: (typeof TOPIC_ROW)[] } = {},
) {
  const botFindFirst = vi.fn(
    async ({ where }: { where: { id: string; spaceId: string; userId: string } }) => {
      if (where.id !== BOT_ID || where.spaceId !== actor.spaceId || where.userId !== actor.userId) {
        return null;
      }
      return { id: BOT_ID, thread: null, computer: null };
    },
  );
  const postFindMany = vi.fn(async () => options.postRows ?? [POST_ROW]);
  const topicRows = options.topicRows ?? [TOPIC_ROW];
  const followedTopicFindMany = vi.fn(async () => topicRows);
  const followedTopicFindUnique = vi.fn(
    async ({ where }: { where: { id: string } }) =>
      topicRows.find((row) => row.id === where.id) ?? null,
  );
  const followedTopicUpsert = vi.fn(async ({ create }: { create: Record<string, unknown> }) => ({
    ...TOPIC_ROW,
    ...create,
    id: "topic-new",
  }));
  const followedTopicDeleteMany = vi.fn(async () => ({ count: 1 }));
  const prisma = {
    bot: { findFirst: botFindFirst },
    post: { findMany: postFindMany },
    followedTopic: {
      findMany: followedTopicFindMany,
      findUnique: followedTopicFindUnique,
      upsert: followedTopicUpsert,
      deleteMany: followedTopicDeleteMany,
    },
  } as unknown as PrismaClient;
  const deps: MuseFeedDeps = { prisma };
  return {
    deps,
    botFindFirst,
    postFindMany,
    followedTopicFindMany,
    followedTopicFindUnique,
    followedTopicUpsert,
    followedTopicDeleteMany,
  };
}

describe("listFeedPosts", () => {
  it("authorizes the bot, then reads its Posts newest first", async () => {
    const { deps, botFindFirst, postFindMany } = fakeDeps();
    const result = await listFeedPosts(deps, actor, { botId: BOT_ID });
    expect(botFindFirst).toHaveBeenCalled();
    expect(postFindMany).toHaveBeenCalled();
    expect(result.posts).toHaveLength(1);
    expect(result.posts[0]?.id).toBe("post-1");
  });

  it("throws IsolationError for a bot that isn't the actor's own", async () => {
    const { deps } = fakeDeps();
    await expect(listFeedPosts(deps, actor, { botId: OTHER_BOT_ID })).rejects.toBeInstanceOf(
      IsolationError,
    );
  });
});

describe("listTopics", () => {
  it("authorizes the bot, then reads its Followed topics", async () => {
    const { deps } = fakeDeps();
    const result = await listTopics(deps, actor, BOT_ID);
    expect(result).toEqual([
      { id: "topic-1", topic: "AI agent news", createdAt: "2026-09-20T00:00:00.000Z" },
    ]);
  });
});

describe("followTopic", () => {
  it("authorizes the bot, then follows the topic", async () => {
    const { deps, followedTopicUpsert } = fakeDeps();
    const result = await followTopic(deps, actor, { botId: BOT_ID, topic: "  AI agent news  " });
    expect(followedTopicUpsert).toHaveBeenCalledWith({
      where: { botId_topic: { botId: BOT_ID, topic: "AI agent news" } },
      create: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: BOT_ID,
        topic: "AI agent news",
      },
      update: {},
    });
    expect(result.id).toBe("topic-new");
  });

  it("throws IsolationError for a bot that isn't the actor's own", async () => {
    const { deps } = fakeDeps();
    await expect(
      followTopic(deps, actor, { botId: OTHER_BOT_ID, topic: "AI agent news" }),
    ).rejects.toBeInstanceOf(IsolationError);
  });
});

describe("removeTopic", () => {
  it("removes a topic that belongs to the actor's own bot", async () => {
    const { deps, followedTopicDeleteMany } = fakeDeps();
    const result = await removeTopic(deps, actor, "topic-1");
    expect(result).toEqual({ ok: true });
    expect(followedTopicDeleteMany).toHaveBeenCalledWith({ where: { id: "topic-1" } });
  });

  it("throws IsolationError for a topic on someone else's bot", async () => {
    const { deps } = fakeDeps({ topicRows: [{ ...TOPIC_ROW, botId: OTHER_BOT_ID }] });
    await expect(removeTopic(deps, actor, "topic-1")).rejects.toBeInstanceOf(IsolationError);
  });

  it("throws IsolationError for a topic that doesn't exist", async () => {
    const { deps } = fakeDeps({ topicRows: [] });
    await expect(removeTopic(deps, actor, "missing")).rejects.toBeInstanceOf(IsolationError);
  });
});
