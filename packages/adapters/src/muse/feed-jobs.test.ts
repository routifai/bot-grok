import { feedTopicsJobKey, museQueueName } from "@aiden/adapter-kit";
import { quietHoursEnd } from "@aiden/core";
import type { PrismaClient } from "@aiden/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFeedJobHandlers,
  FEED_TOPICS_INTERVAL_MS,
  nextFeedTopicsAt,
  rescheduleMuseFeedForBot,
  scheduleFeedDigestOnFirstTopic,
  scheduleFeedTopics,
} from "./feed-jobs.js";

// An in-memory Prisma-shaped store, just enough for feed-jobs.ts. Mirrors the fixture
// pattern in goal-jobs.test.ts.
function createFixture() {
  let seq = 0;
  const nextId = (prefix: string) => `${prefix}-${++seq}`;

  const bots: Record<string, unknown>[] = [];
  const threads: Record<string, unknown>[] = [];
  const followedTopics: Record<string, unknown>[] = [];
  const tasks: Record<string, unknown>[] = [];
  const runs: Record<string, unknown>[] = [];

  function matches(row: Record<string, unknown>, where: Record<string, unknown> = {}): boolean {
    return Object.entries(where).every(([key, value]) => {
      if (value && typeof value === "object" && "in" in (value as object)) {
        return (value as { in: unknown[] }).in.includes(row[key]);
      }
      return row[key] === value;
    });
  }

  function applySelect(row: Record<string, unknown>, select?: Record<string, true>) {
    if (!select) return row;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(select)) out[key] = row[key];
    return out;
  }

  const client = {
    bot: {
      findUnique: async ({
        where,
        include,
        select,
      }: {
        where: { id: string };
        include?: { thread?: boolean; feedLog?: boolean };
        select?: Record<string, true>;
      }) => {
        const bot = bots.find((b) => b.id === where.id);
        if (!bot) return null;
        if (select) return applySelect(bot, select);
        if (!include) return bot;
        const result: Record<string, unknown> = { ...bot };
        if (include.thread) result.thread = threads.find((t) => t.botId === bot.id) ?? null;
        if (include.feedLog)
          result.feedLog = threads.find((t) => t.feedLogBotId === bot.id) ?? null;
        return result;
      },
    },
    thread: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          nextMessageSeq: 0,
          nextEventSeq: 0,
          unread: false,
          botId: null,
          groupId: null,
          goalId: null,
          feedLogBotId: null,
          ...data,
          id: nextId("thread"),
        };
        threads.push(row);
        return row;
      },
    },
    followedTopic: {
      findMany: async ({ where }: { where?: Record<string, unknown> }) =>
        followedTopics.filter((t) => matches(t, where)),
    },
    task: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { status: "queued", ...data, id: nextId("task") };
        tasks.push(row);
        return row;
      },
    },
    run: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { status: "queued", ...data, id: nextId("run") };
        runs.push(row);
        return row;
      },
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        runs.find((r) => matches(r, where)) ?? null,
    },
  };

  return {
    prisma: client as unknown as PrismaClient,
    bots,
    threads,
    followedTopics,
    tasks,
    runs,
  };
}

const BOT_ID = "bot-1";
const SPACE_ID = "space-1";
const USER_ID = "user-1";

type Fixture = ReturnType<typeof createFixture>;

function seedMuse(fixture: Fixture, overrides: Record<string, unknown> = {}) {
  fixture.bots.push({
    id: BOT_ID,
    spaceId: SPACE_ID,
    userId: USER_ID,
    museProactivity: null,
    museQuietHours: null,
    ...overrides,
  });
  const conversation = {
    id: "thread-conversation",
    spaceId: SPACE_ID,
    userId: USER_ID,
    botId: BOT_ID,
    groupId: null,
    goalId: null,
    feedLogBotId: null,
    nextMessageSeq: 0,
    nextEventSeq: 0,
    unread: false,
  };
  fixture.threads.push(conversation);
  return conversation;
}

function seedTopic(fixture: Fixture, topic: string) {
  fixture.followedTopics.push({
    id: `topic-${fixture.followedTopics.length + 1}`,
    spaceId: SPACE_ID,
    userId: USER_ID,
    botId: BOT_ID,
    topic,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  });
}

function deps(
  fixture: Fixture,
  continueRun: (runId: string, workerId: string) => Promise<void> = vi.fn(async () => undefined),
) {
  const jobs = {
    enqueue: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  return { prisma: fixture.prisma, jobs, continueRun, workerId: "worker-1" };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z")); // noon UTC: outside 22:00-08:00 quiet hours
});

afterEach(() => {
  vi.useRealTimers();
});

describe("feed.topics: skip rules", () => {
  it("does nothing when the Muse no longer exists", async () => {
    const fixture = createFixture();
    const d = deps(fixture);
    const handlers = createFeedJobHandlers(d);

    await handlers["feed.topics"]({ botId: BOT_ID });

    expect(d.jobs.enqueue).not.toHaveBeenCalled();
    expect(fixture.runs).toHaveLength(0);
  });

  it("does nothing when proactivity is off", async () => {
    const fixture = createFixture();
    seedMuse(fixture, { museProactivity: "off" });
    seedTopic(fixture, "AI agent news");
    const d = deps(fixture);
    const handlers = createFeedJobHandlers(d);

    await handlers["feed.topics"]({ botId: BOT_ID });

    expect(d.jobs.enqueue).not.toHaveBeenCalled();
    expect(fixture.runs).toHaveLength(0);
    expect(d.continueRun).not.toHaveBeenCalled();
  });
});

describe("feed.topics: quiet hours", () => {
  it("reschedules to the end of quiet hours instead of researching", async () => {
    vi.setSystemTime(new Date("2026-01-01T23:00:00.000Z")); // 23:00 UTC, inside 22:00-08:00
    const fixture = createFixture();
    seedMuse(fixture);
    seedTopic(fixture, "AI agent news");
    const d = deps(fixture);
    const handlers = createFeedJobHandlers(d);

    await handlers["feed.topics"]({ botId: BOT_ID });

    expect(fixture.runs).toHaveLength(0);
    expect(d.continueRun).not.toHaveBeenCalled();
    const expectedEnd = quietHoursEnd("22:00-08:00", new Date("2026-01-01T23:00:00.000Z"), "UTC")!;
    expect(d.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "feed.topics",
        payload: { botId: BOT_ID },
        availableAt: expectedEnd,
        queueName: museQueueName(BOT_ID),
      }),
    );
  });
});

describe("feed.topics: the Conversation goes first", () => {
  it("reschedules +60s when the Conversation has an active run", async () => {
    const fixture = createFixture();
    const conversation = seedMuse(fixture);
    seedTopic(fixture, "AI agent news");
    fixture.runs.push({ id: "run-conversation", threadId: conversation.id, status: "running" });
    const d = deps(fixture);
    const handlers = createFeedJobHandlers(d);

    await handlers["feed.topics"]({ botId: BOT_ID });

    expect(fixture.runs).toHaveLength(1);
    expect(d.continueRun).not.toHaveBeenCalled();
    expect(d.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "feed.topics",
        payload: { botId: BOT_ID },
        availableAt: new Date("2026-01-01T12:01:00.000Z"),
      }),
    );
  });
});

describe("feed.topics: doing the work", () => {
  it("creates a run in the Feed log with every Followed topic, and schedules tomorrow's digest", async () => {
    const fixture = createFixture();
    seedMuse(fixture);
    seedTopic(fixture, "AI agent news");
    seedTopic(fixture, "Moroccan design");
    const d = deps(fixture);
    const handlers = createFeedJobHandlers(d);

    await handlers["feed.topics"]({ botId: BOT_ID });

    expect(fixture.runs).toHaveLength(1);
    expect(fixture.runs[0]).toMatchObject({ trigger: "feed_topics" });
    const feedLog = fixture.threads.find((t) => t.feedLogBotId === BOT_ID);
    expect(feedLog).toBeDefined();
    expect(fixture.runs[0]).toMatchObject({ threadId: feedLog!.id });
    expect(fixture.tasks[0]!.prompt).toContain("AI agent news");
    expect(fixture.tasks[0]!.prompt).toContain("Moroccan design");
    expect(d.continueRun).toHaveBeenCalledWith(fixture.runs[0]!.id, "worker-1");

    expect(d.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "feed.topics",
        payload: { botId: BOT_ID },
        availableAt: new Date("2026-01-02T12:00:00.000Z"),
      }),
    );
  });

  it("reuses the same Feed log thread across firings", async () => {
    const fixture = createFixture();
    seedMuse(fixture);
    seedTopic(fixture, "AI agent news");
    const d = deps(fixture);
    const handlers = createFeedJobHandlers(d);

    await handlers["feed.topics"]({ botId: BOT_ID });
    await handlers["feed.topics"]({ botId: BOT_ID });

    const feedLogs = fixture.threads.filter((t) => t.feedLogBotId === BOT_ID);
    expect(feedLogs).toHaveLength(1);
    expect(fixture.runs).toHaveLength(2);
    expect(fixture.runs[0]!.threadId).toBe(fixture.runs[1]!.threadId);
  });

  it("still reschedules tomorrow's digest, but does no work, when there are no Followed topics", async () => {
    const fixture = createFixture();
    seedMuse(fixture);
    const d = deps(fixture);
    const handlers = createFeedJobHandlers(d);

    await handlers["feed.topics"]({ botId: BOT_ID });

    expect(fixture.runs).toHaveLength(0);
    expect(d.continueRun).not.toHaveBeenCalled();
    expect(d.jobs.enqueue).toHaveBeenCalledWith(expect.objectContaining({ name: "feed.topics" }));
  });
});

describe("nextFeedTopicsAt", () => {
  it("is null when proactivity is off", () => {
    expect(
      nextFeedTopicsAt({ proactivity: "off", quietHours: null }, new Date(), "UTC"),
    ).toBeNull();
  });

  it("is a day out regardless of proactivity level", () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    const low = nextFeedTopicsAt({ proactivity: "low", quietHours: null }, now, "UTC")!;
    const high = nextFeedTopicsAt({ proactivity: "high", quietHours: null }, now, "UTC")!;
    expect(low.getTime() - now.getTime()).toBe(FEED_TOPICS_INTERVAL_MS);
    expect(high.getTime()).toBe(low.getTime());
  });

  it("skips forward to the end of quiet hours when the interval would land inside one", () => {
    const now = new Date("2026-01-01T22:30:00.000Z"); // +24h lands at 22:30 the next day, inside quiet hours
    const next = nextFeedTopicsAt(
      { proactivity: "normal", quietHours: "22:00-08:00" },
      now,
      "UTC",
    )!;
    expect(next).toEqual(
      quietHoursEnd("22:00-08:00", new Date(now.getTime() + FEED_TOPICS_INTERVAL_MS), "UTC"),
    );
  });
});

describe("scheduleFeedTopics / rescheduleMuseFeedForBot / scheduleFeedDigestOnFirstTopic", () => {
  it("scheduleFeedTopics enqueues by the per-Muse replace key", async () => {
    const fixture = createFixture();
    const d = deps(fixture);
    const at = new Date("2026-01-02T12:00:00.000Z");

    await scheduleFeedTopics(d.jobs, BOT_ID, at);

    expect(d.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "feed.topics",
        replaceKey: feedTopicsJobKey(BOT_ID),
        availableAt: at,
      }),
    );
  });

  it("rescheduleMuseFeedForBot cancels the job when proactivity is now off", async () => {
    const fixture = createFixture();
    seedMuse(fixture, { museProactivity: "off" });
    const d = deps(fixture);

    await rescheduleMuseFeedForBot(d, BOT_ID);

    expect(d.jobs.cancel).toHaveBeenCalledWith(feedTopicsJobKey(BOT_ID));
    expect(d.jobs.enqueue).not.toHaveBeenCalled();
  });

  it("rescheduleMuseFeedForBot schedules the next occurrence otherwise", async () => {
    const fixture = createFixture();
    seedMuse(fixture);
    const d = deps(fixture);

    await rescheduleMuseFeedForBot(d, BOT_ID);

    expect(d.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "feed.topics", payload: { botId: BOT_ID } }),
    );
  });

  it("rescheduleMuseFeedForBot is a no-op for a Muse that no longer exists", async () => {
    const fixture = createFixture();
    const d = deps(fixture);

    await rescheduleMuseFeedForBot(d, "missing-bot");

    expect(d.jobs.enqueue).not.toHaveBeenCalled();
    expect(d.jobs.cancel).not.toHaveBeenCalled();
  });

  it("scheduleFeedDigestOnFirstTopic only schedules on the first Followed topic", async () => {
    const fixture = createFixture();
    seedMuse(fixture);
    const d = deps(fixture);

    await scheduleFeedDigestOnFirstTopic(d, BOT_ID, 1);
    expect(d.jobs.enqueue).toHaveBeenCalledTimes(1);

    await scheduleFeedDigestOnFirstTopic(d, BOT_ID, 2);
    expect(d.jobs.enqueue).toHaveBeenCalledTimes(1); // still just the one call from before
  });
});
