import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import {
  createPostRepos,
  createTopicRepos,
  mapFollowedTopic,
  mapPost,
  PostCursorError,
} from "./feed.js";

const postRow = {
  id: "post-1",
  kind: "goal_report",
  title: "Chose your Japanese course",
  body: "Compared four options; Genki I fits best.",
  goalId: "goal-1",
  sourceUrl: null,
  artifactId: null,
  createdAt: new Date("2026-09-27T02:00:00.000Z"),
};

const topicRow = {
  id: "topic-1",
  topic: "AI agent news",
  createdAt: new Date("2026-09-20T00:00:00.000Z"),
};

describe("mapPost", () => {
  it("maps a row to the contract shape", () => {
    expect(mapPost(postRow)).toEqual({
      id: "post-1",
      kind: "goal_report",
      title: "Chose your Japanese course",
      body: "Compared four options; Genki I fits best.",
      goalId: "goal-1",
      sourceUrl: null,
      artifactId: null,
      createdAt: "2026-09-27T02:00:00.000Z",
    });
  });
});

describe("mapFollowedTopic", () => {
  it("maps a row to the contract shape", () => {
    expect(mapFollowedTopic(topicRow)).toEqual({
      id: "topic-1",
      topic: "AI agent news",
      createdAt: "2026-09-20T00:00:00.000Z",
    });
  });
});

describe("createPostRepos", () => {
  function reposFor(rows: unknown[]) {
    const post = {
      findMany: vi.fn(async (_args: Record<string, unknown>) => rows),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...postRow,
        ...data,
        id: "post-new",
        createdAt: new Date("2026-09-27T03:00:00.000Z"),
      })),
    };
    const prisma = { post };
    return { repos: createPostRepos(prisma as unknown as PrismaClient), post };
  }

  it("listPosts reads a Muse's Posts newest first with no cursor when the page isn't full", async () => {
    const { repos, post } = reposFor([postRow]);
    const result = await repos.listPosts("bot-1");
    expect(post.findMany).toHaveBeenCalledWith({
      where: { botId: "bot-1" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 31,
    });
    expect(result).toEqual({ posts: [mapPost(postRow)], nextCursor: null });
  });

  it("listPosts returns a cursor when there's another page, and decodes it back on the next call", async () => {
    const rows = Array.from({ length: 31 }, (_, i) => ({
      ...postRow,
      id: `post-${i}`,
      createdAt: new Date(postRow.createdAt.getTime() - i * 1000),
    }));
    const { repos, post } = reposFor(rows);
    const page = await repos.listPosts("bot-1");
    expect(page.posts).toHaveLength(30);
    expect(page.nextCursor).not.toBeNull();

    await repos.listPosts("bot-1", page.nextCursor!);
    const secondCall = post.findMany.mock.calls[1]![0] as {
      where: { botId: string; OR: unknown[] };
    };
    expect(secondCall.where.botId).toBe("bot-1");
    expect(secondCall.where.OR).toEqual([
      { createdAt: { lt: rows[29]!.createdAt } },
      { createdAt: rows[29]!.createdAt, id: { lt: "post-29" } },
    ]);
  });

  it("listPosts rejects a malformed cursor", async () => {
    const { repos } = reposFor([]);
    await expect(repos.listPosts("bot-1", "not-a-cursor")).rejects.toBeInstanceOf(PostCursorError);
  });

  it("createPost writes a goal_report Post scoped to the Muse", async () => {
    const { repos, post } = reposFor([]);
    const result = await repos.createPost(
      { spaceId: "space-1", userId: "user-1", botId: "bot-1" },
      { kind: "goal_report", title: "Goal update", body: "Made progress.", goalId: "goal-1" },
    );
    expect(post.create).toHaveBeenCalledWith({
      data: {
        spaceId: "space-1",
        userId: "user-1",
        botId: "bot-1",
        kind: "goal_report",
        title: "Goal update",
        body: "Made progress.",
        goalId: "goal-1",
        sourceUrl: null,
        artifactId: null,
      },
    });
    expect(result.id).toBe("post-new");
  });

  it("createPost writes a topic Post with a sourceUrl", async () => {
    const { repos, post } = reposFor([]);
    await repos.createPost(
      { spaceId: "space-1", userId: "user-1", botId: "bot-1" },
      {
        kind: "topic",
        title: "New agents ship",
        body: "Two new agents launched this week.",
        sourceUrl: "https://example.com/agents",
      },
    );
    expect(post.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: "topic",
        goalId: null,
        sourceUrl: "https://example.com/agents",
        artifactId: null,
      }),
    });
  });
});

describe("createTopicRepos", () => {
  function reposFor(rows: unknown[]) {
    const followedTopic = {
      findMany: vi.fn(async () => rows),
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          rows.find((row) => (row as { id: string }).id === where.id) ?? null,
      ),
      upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => ({
        ...topicRow,
        ...create,
        id: "topic-new",
      })),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    };
    const prisma = { followedTopic };
    return { repos: createTopicRepos(prisma as unknown as PrismaClient), followedTopic };
  }

  it("listTopics reads a Muse's Followed topics oldest first", async () => {
    const { repos, followedTopic } = reposFor([topicRow]);
    const result = await repos.listTopics("bot-1");
    expect(followedTopic.findMany).toHaveBeenCalledWith({
      where: { botId: "bot-1" },
      orderBy: { createdAt: "asc" },
    });
    expect(result).toEqual([mapFollowedTopic(topicRow)]);
  });

  it("getTopic returns the topic with its botId, or null", async () => {
    const { repos } = reposFor([{ ...topicRow, botId: "bot-1" }]);
    expect(await repos.getTopic("topic-1")).toEqual({
      ...mapFollowedTopic(topicRow),
      botId: "bot-1",
    });
    expect(await repos.getTopic("missing")).toBeNull();
  });

  it("followTopic upserts on [botId, topic], following the same topic twice idempotently", async () => {
    const { repos, followedTopic } = reposFor([]);
    const result = await repos.followTopic(
      { spaceId: "space-1", userId: "user-1", botId: "bot-1" },
      "AI agent news",
    );
    expect(followedTopic.upsert).toHaveBeenCalledWith({
      where: { botId_topic: { botId: "bot-1", topic: "AI agent news" } },
      create: { spaceId: "space-1", userId: "user-1", botId: "bot-1", topic: "AI agent news" },
      update: {},
    });
    expect(result.id).toBe("topic-new");
  });

  it("removeTopic deletes by id without erroring when it's already gone", async () => {
    const { repos, followedTopic } = reposFor([]);
    await repos.removeTopic("topic-1");
    expect(followedTopic.deleteMany).toHaveBeenCalledWith({ where: { id: "topic-1" } });
  });

  it("removeTopicByName reports whether anything was removed", async () => {
    const { repos, followedTopic } = reposFor([]);
    expect(await repos.removeTopicByName("bot-1", "AI agent news")).toBe(true);
    expect(followedTopic.deleteMany).toHaveBeenCalledWith({
      where: { botId: "bot-1", topic: "AI agent news" },
    });
  });
});
