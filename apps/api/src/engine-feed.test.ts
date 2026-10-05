import type { PrismaClient } from "@aiden/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  engineFollowTopic,
  engineListFeedPosts,
  engineListTopics,
  engineRemoveTopic,
} from "./engine-feed.js";

const client = { baseUrl: "http://engine.test", proxySecret: "proxy", secrets: [] };
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
  prompt: "p",
  rrule: "FREQ=WEEKLY",
  timezone: "UTC",
  state: "active",
  parent_session_id: "sess-1",
  agent_type: "worker",
  created_at: 1_700_000_000,
  ...extra,
});

const assistant = (id: string, text: string) => ({
  id,
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text }],
  created_at: 1,
});

afterEach(() => vi.unstubAllGlobals());

describe("engine feed", () => {
  it("lists only worker tasks of this Super Chat as topics", async () => {
    stub({
      "GET /v1/scheduled-tasks": {
        scheduled_tasks: [
          topic("t1", "AI agent news"),
          topic("t2", "Other", { agent_type: null }),
          topic("t3", "Foreign", { parent_session_id: "sess-2" }),
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
    ]);
  });

  it("derives the cadence from the rrule frequency", async () => {
    stub({
      "GET /v1/scheduled-tasks": {
        scheduled_tasks: [
          topic("t1", "A", { rrule: "FREQ=DAILY;BYHOUR=9" }),
          topic("t2", "B", { rrule: "FREQ=HOURLY" }),
          topic("t3", "C", { rrule: "FREQ=MONTHLY" }),
        ],
      },
    });
    const topics = await engineListTopics(deps(), client, actor, "bot-1");
    expect(topics.map((entry) => entry.cadence)).toEqual(["daily", "hourly", undefined]);
  });

  it("has no topics or posts before the Muse has a Conversation", async () => {
    expect(await engineListTopics(deps(null), client, actor, "bot-1")).toEqual([]);
    expect(await engineListFeedPosts(deps(null), client, actor, "bot-1")).toEqual({
      posts: [],
      nextCursor: null,
    });
  });

  it("turns succeeded runs into posts newest first and drops Nothing new.", async () => {
    stub({
      "GET /v1/scheduled-tasks": { scheduled_tasks: [topic("t1", "AI agent news")] },
      "GET /v1/scheduled-tasks/t1/runs": {
        runs: [
          {
            id: "r3",
            scheduled_task_id: "t1",
            status: "running",
            scheduled_at: 30,
            conversation_id: "c3",
            fired_at: 30,
            finished_at: null,
          },
          {
            id: "r2",
            scheduled_task_id: "t1",
            status: "succeeded",
            scheduled_at: 20,
            conversation_id: "c2",
            fired_at: 20,
            finished_at: 25,
          },
          {
            id: "r1",
            scheduled_task_id: "t1",
            status: "succeeded",
            scheduled_at: 10,
            conversation_id: "c1",
            fired_at: 10,
            finished_at: 15,
          },
          {
            id: "r0",
            scheduled_task_id: "t1",
            status: "succeeded",
            scheduled_at: 5,
            conversation_id: "c0",
            fired_at: 5,
            finished_at: 6,
          },
        ],
      },
      "GET /v1/sessions/c2/items": { data: [assistant("i2", "Nothing new.")] },
      "GET /v1/sessions/c1/items": {
        data: [assistant("i1b", "New release shipped."), assistant("i1a", "Working on it")],
      },
      "GET /v1/sessions/c0/items": { data: [assistant("i0", "Older finding.")] },
    });
    const { posts } = await engineListFeedPosts(deps(), client, actor, "bot-1");
    expect(posts.map((p) => [p.id, p.title, p.body, p.kind])).toEqual([
      ["r1", "AI agent news", "New release shipped.", "topic"],
      ["r0", "AI agent news", "Older finding.", "topic"],
    ]);
  });

  it("follows by creating a weekly worker task on the Super Chat", async () => {
    const fetchMock = stub({
      "GET /v1/scheduled-tasks": { scheduled_tasks: [] },
      "POST /v1/scheduled-tasks": topic("t9", "Fusion power"),
    });
    const followed = await engineFollowTopic(deps(), client, actor, {
      botId: "bot-1",
      topic: " Fusion power ",
    });
    expect(followed.id).toBe("t9");
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(post?.[1]?.body as string)).toMatchObject({
      name: "Fusion power",
      rrule: "FREQ=WEEKLY",
      parent_session_id: "sess-1",
      agent_type: "worker",
    });
  });

  it("unfollows by deleting the task, only when it is the actor's followed topic", async () => {
    const fetchMock = stub({
      "GET /v1/scheduled-tasks/t1": topic("t1", "AI agent news"),
      "DELETE /v1/scheduled-tasks/t1": { ok: true },
    });
    expect(await engineRemoveTopic(deps(), client, actor, "t1")).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const foreign = deps();
    (foreign.prisma.omnigentSession.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await expect(engineRemoveTopic(foreign, client, actor, "t1")).rejects.toThrow(
      "Topic not found",
    );
  });
});
