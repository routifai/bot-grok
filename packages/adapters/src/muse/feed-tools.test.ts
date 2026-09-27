import type { JobPublisher } from "@aiden/adapter-kit";
import type { PrismaClient } from "@aiden/db";
import { describe, expect, it, vi } from "vitest";
import { addTopicPostFromTool, followTopicFromTool, unfollowTopicFromTool } from "./feed-tools.js";

const SPACE_ID = "space-1";
const USER_ID = "user-1";
const BOT_ID = "bot-1";

function createFixture() {
  const followedTopics: Record<string, unknown>[] = [];
  const posts: Record<string, unknown>[] = [];
  let seq = 0;

  const client = {
    followedTopic: {
      findMany: async ({ where }: { where?: { botId?: string } }) =>
        followedTopics.filter((t) => !where?.botId || t.botId === where.botId),
      upsert: async ({
        where,
        create,
      }: {
        where: { botId_topic: { botId: string; topic: string } };
        create: Record<string, unknown>;
      }) => {
        const existing = followedTopics.find(
          (t) => t.botId === where.botId_topic.botId && t.topic === where.botId_topic.topic,
        );
        if (existing) return existing;
        const row = { ...create, id: `topic-${++seq}`, createdAt: new Date() };
        followedTopics.push(row);
        return row;
      },
      deleteMany: async ({ where }: { where: { botId: string; topic: string } }) => {
        const before = followedTopics.length;
        const remaining = followedTopics.filter(
          (t) => !(t.botId === where.botId && t.topic === where.topic),
        );
        followedTopics.length = 0;
        followedTopics.push(...remaining);
        return { count: before - remaining.length };
      },
    },
    post: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { ...data, id: `post-${++seq}`, createdAt: new Date() };
        posts.push(row);
        return row;
      },
    },
    bot: {
      findUnique: async () => ({ museProactivity: null, museQuietHours: null }),
    },
  };

  return { prisma: client as unknown as PrismaClient, followedTopics, posts };
}

const scope = { spaceId: SPACE_ID, userId: USER_ID, botId: BOT_ID };

describe("followTopicFromTool", () => {
  it("follows a new topic", async () => {
    const fixture = createFixture();
    const result = await followTopicFromTool({ prisma: fixture.prisma }, scope, {
      topic: "  AI agent news  ",
    });
    expect(result).toEqual({ topic: expect.objectContaining({ topic: "AI agent news" }) });
    expect(fixture.followedTopics).toHaveLength(1);
  });

  it("rejects an empty topic", async () => {
    const fixture = createFixture();
    const result = await followTopicFromTool({ prisma: fixture.prisma }, scope, { topic: "   " });
    expect(result).toEqual({ error: expect.stringContaining("required") });
  });

  it("schedules the Feed digest on the first Followed topic when a job publisher is given", async () => {
    const fixture = createFixture();
    const jobs = {
      enqueue: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    } as unknown as JobPublisher;

    await followTopicFromTool({ prisma: fixture.prisma, jobs }, scope, { topic: "AI agent news" });
    expect(jobs.enqueue).toHaveBeenCalledTimes(1);

    await followTopicFromTool({ prisma: fixture.prisma, jobs }, scope, {
      topic: "Moroccan design",
    });
    expect(jobs.enqueue).toHaveBeenCalledTimes(1); // still just the first-topic schedule
  });

  it("does not schedule anything without a job publisher", async () => {
    const fixture = createFixture();
    await followTopicFromTool({ prisma: fixture.prisma }, scope, { topic: "AI agent news" });
    expect(fixture.followedTopics).toHaveLength(1); // no error, no job queue needed
  });
});

describe("unfollowTopicFromTool", () => {
  it("unfollows an existing topic", async () => {
    const fixture = createFixture();
    await followTopicFromTool({ prisma: fixture.prisma }, scope, { topic: "AI agent news" });
    const result = await unfollowTopicFromTool(
      { prisma: fixture.prisma },
      { botId: BOT_ID },
      {
        topic: "AI agent news",
      },
    );
    expect(result).toEqual({ ok: true });
    expect(fixture.followedTopics).toHaveLength(0);
  });

  it("errors when the topic isn't followed", async () => {
    const fixture = createFixture();
    const result = await unfollowTopicFromTool(
      { prisma: fixture.prisma },
      { botId: BOT_ID },
      {
        topic: "Nothing followed",
      },
    );
    expect(result).toEqual({ error: expect.stringContaining("Not following") });
  });
});

describe("addTopicPostFromTool", () => {
  it("adds a topic Post with a valid http(s) sourceUrl", async () => {
    const fixture = createFixture();
    const result = await addTopicPostFromTool({ prisma: fixture.prisma }, scope, {
      title: "New agents ship",
      body: "Two new agents launched this week.",
      sourceUrl: "https://example.com/agents",
    });
    expect(result).toEqual({
      post: expect.objectContaining({ kind: "topic", title: "New agents ship" }),
    });
    expect(fixture.posts[0]).toMatchObject({ spaceId: SPACE_ID, botId: BOT_ID, kind: "topic" });
  });

  it("rejects a missing title or body", async () => {
    const fixture = createFixture();
    expect(
      await addTopicPostFromTool({ prisma: fixture.prisma }, scope, {
        title: "",
        body: "Body",
        sourceUrl: "https://example.com",
      }),
    ).toEqual({ error: expect.stringContaining("title") });
    expect(
      await addTopicPostFromTool({ prisma: fixture.prisma }, scope, {
        title: "Title",
        body: "",
        sourceUrl: "https://example.com",
      }),
    ).toEqual({ error: expect.stringContaining("body") });
  });

  it("rejects a non-http(s) or malformed sourceUrl", async () => {
    const fixture = createFixture();
    expect(
      await addTopicPostFromTool({ prisma: fixture.prisma }, scope, {
        title: "Title",
        body: "Body",
        sourceUrl: "not-a-url",
      }),
    ).toEqual({ error: expect.stringContaining("sourceUrl") });
    expect(
      await addTopicPostFromTool({ prisma: fixture.prisma }, scope, {
        title: "Title",
        body: "Body",
        sourceUrl: "ftp://example.com/file",
      }),
    ).toEqual({ error: expect.stringContaining("sourceUrl") });
  });
});
