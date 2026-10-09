import type { PrismaClient } from "@nova/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  engineFollowTopic,
  engineListFeedPosts,
  engineListTopics,
  engineRemoveTopic,
} from "./engine-feed.js";

const client = {
  baseUrl: "http://engine.test",
  proxySecret: "proxy",
  secrets: [],
  tenant: "space-1",
};
const actor = { userId: "user-1", spaceId: "space-1" } as never;

function deps(session: string | null = "sess-1") {
  const prisma = {
    bot: { findFirst: vi.fn(async () => ({ id: "bot-1" })) },
    user: { findUnique: vi.fn(async () => ({ email: "p@example.test" })) },
    omnigentSession: {
      findUnique: vi.fn(async () => (session ? { omnigentSessionId: session } : null)),
      findFirst: vi.fn(async () => ({ botId: "bot-1" })),
    },
  };
  return { prisma: prisma as unknown as PrismaClient };
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

function stub(routes: Record<string, unknown>) {
  const fetchMock = vi.fn(async (url: URL, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    if (!(key in routes)) throw new Error(`unexpected ${key}`);
    return json(routes[key]);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const topic = (id: string, name: string, extra = {}) => ({
  id,
  name,
  cadence: "weekly",
  rrule: "FREQ=WEEKLY",
  timezone: "UTC",
  state: "active",
  session_id: "sess-1",
  created_at: 1_700_000_000,
  ...extra,
});

const post = (id: string, topicId: string, text: string, createdAt: number) => ({
  id,
  topic_id: topicId,
  run_id: id,
  session_id: `run-${id}`,
  created_at: createdAt,
  text,
  cards: [],
  nothing_new: false,
});

afterEach(() => vi.unstubAllGlobals());

describe("engine feed", () => {
  it("lists only this Super Chat's topics, with the engine's cadence", async () => {
    stub({
      "GET /v1/me/topics": {
        data: [
          topic("t1", "AI agent news"),
          topic("t2", "Daily", { cadence: "daily" }),
          topic("t3", "Monthly", { cadence: null }),
          topic("t4", "Foreign", { session_id: "sess-2" }),
        ],
      },
    });
    const topics = await engineListTopics(deps(), client, actor, "bot-1");
    expect(topics).toEqual([
      {
        id: "t1",
        topic: "AI agent news",
        createdAt: "2023-11-14T22:13:20.000Z",
        cadence: "weekly",
      },
      { id: "t2", topic: "Daily", createdAt: "2023-11-14T22:13:20.000Z", cadence: "daily" },
      { id: "t3", topic: "Monthly", createdAt: "2023-11-14T22:13:20.000Z" },
    ]);
  });

  it("has no topics or posts before the Muse has a Conversation", async () => {
    expect(await engineListTopics(deps(null), client, actor, "bot-1")).toEqual([]);
    expect(await engineListFeedPosts(deps(null), client, actor, { botId: "bot-1" })).toEqual({
      posts: [],
      nextCursor: null,
    });
  });

  it("shows the engine's posts of this Muse's topics and pages with its cursor", async () => {
    const fetchMock = stub({
      "GET /v1/me/topics": {
        data: [topic("t1", "AI agent news"), topic("t2", "Foreign", { session_id: "sess-2" })],
      },
      "GET /v1/me/feed": {
        data: [
          post("r2", "t1", "New release shipped.", 20),
          post("r9", "t2", "Someone else's Muse.", 15),
          post("r1", "t1", "Older finding.", 10),
        ],
        has_more: true,
        next_cursor: "10:r1",
      },
    });
    const page = await engineListFeedPosts(deps(), client, actor, {
      botId: "bot-1",
      cursor: "30:r3",
    });
    expect(page.posts.map((p) => [p.id, p.title, p.body, p.kind])).toEqual([
      ["r2", "AI agent news", "New release shipped.", "topic"],
      ["r1", "AI agent news", "Older finding.", "topic"],
    ]);
    expect(page.nextCursor).toBe("10:r1");
    const feedUrl = fetchMock.mock.calls
      .map(([url]) => url as URL)
      .find((url) => url.pathname === "/v1/me/feed");
    expect(feedUrl?.searchParams.get("before")).toBe("30:r3");
  });

  it("follows by creating a weekly followed-topic task on the Super Chat", async () => {
    const fetchMock = stub({
      "GET /v1/me/topics": { data: [] },
      "POST /v1/scheduled-tasks": { ...topic("t9", "Fusion power"), prompt: "p" },
    });
    const followed = await engineFollowTopic(deps(), client, actor, {
      botId: "bot-1",
      topic: " Fusion power ",
    });
    expect(followed.id).toBe("t9");
    const created = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(created?.[1]?.body as string)).toMatchObject({
      name: "Fusion power",
      rrule: "FREQ=WEEKLY",
      parent_session_id: "sess-1",
      agent_type: "worker",
      kind: "followed_topic",
    });
  });

  it("unfollows by deleting the task, only when it is the actor's followed topic", async () => {
    const fetchMock = stub({
      "GET /v1/me/topics": { data: [topic("t1", "AI agent news")] },
      "DELETE /v1/scheduled-tasks/t1": { ok: true },
    });
    expect(await engineRemoveTopic(deps(), client, actor, "t1")).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const foreign = deps();
    (foreign.prisma.omnigentSession.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await expect(engineRemoveTopic(foreign, client, actor, "t1")).rejects.toThrow(
      "Topic not found",
    );
    await expect(engineRemoveTopic(deps(), client, actor, "t-missing")).rejects.toThrow(
      "Topic not found",
    );
  });
});
