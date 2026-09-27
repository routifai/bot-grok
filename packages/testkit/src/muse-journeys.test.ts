// End-to-end Muse edition journey (docs/muse/PLAN.md B4/B6/B8/B9/B10/B11; CONTEXT.md
// "Goal", "Proposal", "Ask", "Feed", "Post", "Followed topic", "Idea"). Pattern:
// journeys.test.ts — a real createApp (oRPC router + in-process job runner) against the
// real local Postgres, WAKEUP_DRIVER=memory, SANDBOX_PROVIDER=fake, AGENT_RUNTIME=scripted
// so only the model and the sandbox are stubbed.
//
// The scripted runtime infers its script from a run's static task-prompt text
// (packages/adapters/src/scripted-runtime.ts), which has no way to echo back a dynamic
// Goal/Task id it was never given. That covers Goal creation (the person's own words)
// and the Feed digest (topic names are the whole prompt), but not `update_task` on a
// specific Task — so the blocked-Task step below calls that tool handler directly
// (packages/adapters/src/muse/goal-tools.ts, exported for exactly this) against the same
// real Postgres-backed prisma the rest of the journey uses, instead of steering a
// scripted turn's text.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRuntime } from "@aiden/adapter-kit";
import { feedTopicsJob } from "@aiden/adapter-kit";
import { ComposioEmulator, refreshIdeas, updateGoalTaskFromTool } from "@aiden/adapters";
import type { Ask, Goal, Me } from "@aiden/contracts";
import { ILLUSTRATION_KEYS } from "@aiden/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { createApp } from "../../../apps/api/src/app.ts";
import type { BotIntroHarness } from "./discard-bot-intro.js";
import { discardBotIntroFromCreate } from "./discard-bot-intro.js";
import { sessionCookieHeader } from "./index.js";

type App = { request: (input: string, init?: RequestInit) => Promise<Response> };
process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeJourney = hasDb ? describe : describe.skip;
let botIntroHarness: BotIntroHarness | undefined;

describeJourney("Muse edition journey", () => {
  let app: App;
  let stop: () => Promise<void>;
  let prisma: Awaited<ReturnType<typeof createApp>>["prisma"];
  let jobs: Awaited<ReturnType<typeof createApp>>["jobs"];
  const stamp = Date.now();
  const dataDir = mkdtempSync(path.join(tmpdir(), "aiden-muse-journey-"));

  beforeAll(async () => {
    const { createApp } = await import("../../../apps/api/src/app.ts");
    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      productMode: "muse",
      composio: new ComposioEmulator(),
    });
    app = handles.app;
    stop = handles.stop;
    prisma = handles.prisma;
    jobs = handles.jobs;
    botIntroHarness = handles;
  });

  afterAll(async () => {
    await stop?.();
  });

  it("covers Goal creation through Proposal/Ask, background advance, blocked Task, Feed topics, and Ideas", async () => {
    const cookie = await signup(app, `muse-journey-${stamp}@aiden.test`, "Muse Journey");
    const me = await rpc<Me>(app, cookie, "me");
    const bot = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "Aiden",
      title: "Muse",
      description: "Personal Muse",
      instructions: "",
    });

    // Quiet hours default to 22:00-08:00 UTC (DEFAULT_MUSE_SETTINGS); disable them so the
    // background jobs below never depend on the wall-clock time this test happens to run at.
    await rpc(app, cookie, "muse/updateSettings", {
      botId: bot.id,
      proactivity: "high",
      quietHours: null,
    });

    // 1. A Conversation message the scripted runtime turns into a `goals` tool `create`
    // call (packages/adapters/src/scripted-runtime.ts), which makes the Goal and its
    // first-plan Proposal (packages/adapters/src/muse/goal-tools.ts).
    await sendAndWait(
      app,
      prisma,
      cookie,
      bot.id,
      "Set up a Goal called Learn Japanese with tasks: Pick a course, Book trial lessons",
    );
    const goal = await prisma.goal.findFirstOrThrow({ where: { botId: bot.id } });
    expect(goal.title).toBe("Learn Japanese");

    // 2. The Proposal surfaces as an open Ask, both directly and inside the Feed.
    const asksAfterCreate = await rpc<Ask[]>(app, cookie, "asks/list", { botId: bot.id });
    expect(asksAfterCreate).toHaveLength(1);
    const proposalAsk = asksAfterCreate[0]!;
    expect(proposalAsk).toMatchObject({ kind: "proposal", goalId: goal.id });
    expect(await rpc<{ count: number }>(app, cookie, "asks/count", { botId: bot.id })).toEqual({
      count: 1,
    });
    const feedAfterCreate = await rpc<{ asks: Ask[]; posts: unknown[] }>(app, cookie, "feed/list", {
      botId: bot.id,
    });
    expect(feedAfterCreate.asks.map((ask) => ask.id)).toContain(proposalAsk.id);

    // 3. Answering "accept" accepts the Proposal: the Goal's Tasks exist, the Ask closes,
    // goal.advance wakes immediately, and ideas.refresh is enqueued
    // (packages/adapters/src/muse/goal-proposals.ts). This is the fix under test: `jobs`
    // must be forwarded from apps/api/src/muse-asks.ts into that shared apply path, or
    // neither ever fires.
    const enqueueSpy = vi.spyOn(jobs, "enqueue");
    await rpc(app, cookie, "asks/answer", {
      askId: proposalAsk.id,
      runId: proposalAsk.runId,
      answer: "accept",
    });
    const enqueuedNames = () => enqueueSpy.mock.calls.map(([job]) => job.name);
    await waitForDatabase(async () => enqueuedNames().includes("goal.advance"));
    expect(enqueuedNames()).toContain("ideas.refresh");
    const tasksAfterAccept = await prisma.goalTask.findMany({
      where: { goalId: goal.id },
      orderBy: { idx: "asc" },
    });
    expect(tasksAfterAccept.map((task) => task.title)).toEqual([
      "Pick a course",
      "Book trial lessons",
    ]);
    expect(tasksAfterAccept.every((task) => task.status === "pending")).toBe(true);
    expect(await rpc<Ask[]>(app, cookie, "asks/list", { botId: bot.id })).toHaveLength(0);

    // 4. The woken goal.advance job runs in the Goal log, reports back to the
    // Conversation, writes a `goal_report` Post, stamps lastWorkedAt, and reschedules.
    await waitForDatabase(async () => {
      const row = await prisma.goal.findUniqueOrThrow({ where: { id: goal.id } });
      return row.lastWorkedAt !== null;
    });
    const advanceRun = await prisma.run.findFirstOrThrow({
      where: { botId: bot.id, trigger: "goal_advance" },
      orderBy: { createdAt: "desc" },
    });
    expect(advanceRun.status).toBe("completed");
    const conversation = await rpc<{ messages: Array<{ blocks: unknown[] }> }>(
      app,
      cookie,
      "threads/get",
      { botId: bot.id },
    );
    const reportText = JSON.stringify(conversation.messages.at(-1)?.blocks ?? "");
    expect(reportText.length).toBeGreaterThan(2);
    const goalReportPost = await prisma.post.findFirstOrThrow({
      where: { botId: bot.id, kind: "goal_report", goalId: goal.id },
    });
    expect(goalReportPost.body.length).toBeGreaterThan(0);
    expect(
      enqueueSpy.mock.calls.filter(([job]) => job.name === "goal.advance").length,
    ).toBeGreaterThanOrEqual(2); // the wake, plus the reschedule after this advance.

    // 5. goals.list/get/log reflect all of the above.
    const goalsList = await rpc<Goal[]>(app, cookie, "goals/list", { botId: bot.id });
    expect(goalsList.map((g) => g.id)).toContain(goal.id);
    const goalGet = await rpc<Goal>(app, cookie, "goals/get", { goalId: goal.id });
    expect(goalGet).toMatchObject({ id: goal.id, openProposal: null });
    expect(goalGet.tasks).toHaveLength(2);
    const goalLog = await rpc<{ messages: unknown[] }>(app, cookie, "goals/log", {
      goalId: goal.id,
    });
    expect(goalLog.messages.length).toBeGreaterThan(0);

    // 6. A blocked Task Ask, answered, puts the Task back to pending. The scripted
    // runtime cannot target this specific Task id from prompt text alone (see the file
    // header), so this calls the same tool handler run-executor.ts's dispatch calls,
    // directly against the real Postgres-backed prisma the rest of this test already used.
    const blockedTask = tasksAfterAccept[0]!;
    const blockedNote = "Need your calendar availability before I can book anything.";
    const blocked = await updateGoalTaskFromTool(
      { prisma, events: { notify: async () => undefined }, jobs },
      { spaceId: me.spaceId, botId: bot.id, userId: me.userId, runId: advanceRun.id },
      { goalId: goal.id, taskId: blockedTask.id, status: "blocked", note: blockedNote },
    );
    expect(blocked).not.toHaveProperty("error");
    const blockedAsks = await rpc<Ask[]>(app, cookie, "asks/list", { botId: bot.id });
    expect(blockedAsks).toHaveLength(1);
    const blockedAsk = blockedAsks[0]!;
    expect(blockedAsk).toMatchObject({ kind: "blocked_task", goalId: goal.id, text: blockedNote });
    await rpc(app, cookie, "asks/answer", {
      askId: blockedAsk.id,
      runId: blockedAsk.runId,
      answer: "Tuesdays and Thursdays work best for me.",
    });
    const unblockedTask = await prisma.goalTask.findUniqueOrThrow({
      where: { id: blockedTask.id },
    });
    expect(unblockedTask.status).toBe("pending");
    expect(unblockedTask.note).toContain("Tuesdays and Thursdays work best for me.");
    expect(await rpc<Ask[]>(app, cookie, "asks/list", { botId: bot.id })).toHaveLength(0);

    // 7. Following a topic schedules feed.topics; running it with a scripted model that
    // calls feed_add_topic_post produces a topic Post with a real sourceUrl.
    await rpc(app, cookie, "topics/follow", { botId: bot.id, topic: "AI regulation news" });
    expect(enqueuedNames()).toContain("feed.topics");
    await jobs.enqueue(feedTopicsJob(bot.id)); // Run it now instead of waiting ~24h.
    await waitForDatabase(async () => {
      const post = await prisma.post.findFirst({ where: { botId: bot.id, kind: "topic" } });
      return post !== null;
    });
    const topicPost = await prisma.post.findFirstOrThrow({
      where: { botId: bot.id, kind: "topic" },
    });
    expect(topicPost.sourceUrl).toMatch(/^https?:\/\//);
    const feedAfterTopics = await rpc<{ posts: Array<{ kind: string; sourceUrl: string | null }> }>(
      app,
      cookie,
      "feed/list",
      { botId: bot.id },
    );
    expect(feedAfterTopics.posts.some((post) => post.kind === "topic" && post.sourceUrl)).toBe(
      true,
    );

    // 8. ideas.refresh, given a scripted completion, stores Ideas with title, detail, and
    // illustration. The app's own runtime is intentionally never model-capable for this
    // one-shot completion (ScriptedAgentRuntime.describe().capabilities.compaction is
    // false, mirroring history-compaction.ts's same skip — see packages/adapters/src/
    // muse/ideas.ts and its own unit test's identical fake-runtime technique), so this
    // calls refreshIdeas directly with a small deterministic fake runtime instead, against
    // the same real Postgres-backed prisma and idea repos the `ideas.list` RPC reads back
    // from below.
    const fakeIdeaRuntime: AgentRuntime = {
      describe: () => ({
        id: "fake-ideas-for-test",
        contractVersion: "1",
        adapterVersion: "0.1.0",
        capabilities: { streaming: false, compaction: true, tools: false, scripted: false },
      }),
      abort: async () => undefined,
      async *run() {
        const drafts = Array.from({ length: 6 }, (_, index) => ({
          text: `I can help with idea ${index + 1}`,
          area: "learning",
          detail: `Concretely, I would help with step ${index + 1} of the plan.`,
          illustration: ILLUSTRATION_KEYS[index % ILLUSTRATION_KEYS.length],
        }));
        yield { type: "done" as const, text: JSON.stringify(drafts) };
      },
    };
    const ideas = await refreshIdeas(
      {
        prisma,
        runtime: fakeIdeaRuntime,
        memory: {
          describe: () => ({ capabilities: {} }),
          read: async () => ({ documents: [] }),
          search: async () => [],
          commit: async () => ({ revision: "rev-1" }),
          exportMarkdown: async function* () {},
        } as never,
        deploymentModelKey: "test-fake-deployment-key",
      },
      bot.id,
    );
    expect(ideas).toHaveLength(6);
    expect(ideas[0]).toMatchObject({
      text: expect.stringContaining("I can help"),
      area: "learning",
      detail: expect.stringContaining("Concretely"),
      illustration: expect.any(String),
    });
    const ideasList = await rpc<Array<{ text: string }>>(app, cookie, "ideas/list", {
      botId: bot.id,
    });
    expect(ideasList).toHaveLength(6);
  });
});

async function signup(app: App, email: string, name: string) {
  const res = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://127.0.0.1:5173",
    },
    body: JSON.stringify({ email, password: "password12", name }),
  });
  if (res.status >= 400) {
    throw new Error(`signup failed ${res.status}: ${await res.text()}`);
  }
  return sessionCookieHeader(res);
}

async function raw(app: App, cookie: string, proc: string, body: unknown = {}) {
  return app.request(`/rpc/${proc}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      origin: "http://127.0.0.1:5173",
    },
    body: JSON.stringify({ json: body }),
  });
}

async function rpc<T>(app: App, cookie: string, proc: string, body: unknown = {}): Promise<T> {
  const res = await raw(app, cookie, proc, body);
  const text = await res.text();
  let parsed: { json?: T; error?: { message?: string } };
  try {
    parsed = JSON.parse(text) as { json?: T; error?: { message?: string } };
  } catch {
    throw new Error(`${proc} ${res.status}: ${text}`);
  }
  if (res.status >= 400 || parsed.error) {
    throw new Error(`${proc} ${res.status}: ${parsed.error?.message ?? text}`);
  }
  return discardBotIntroFromCreate(botIntroHarness, cookie, proc, parsed.json as T);
}

async function sendAndWait(
  app: App,
  prisma: Awaited<ReturnType<typeof createApp>>["prisma"],
  cookie: string,
  botId: string,
  text: string,
) {
  const { runId } = await rpc<{ runId: string }>(app, cookie, "threads/send", { botId, text });
  let terminal: { status: string; error: string | null } | null = null;
  await waitForDatabase(async () => {
    terminal = await prisma.run.findUnique({
      where: { id: runId },
      select: { status: true, error: true },
    });
    return Boolean(terminal && ["completed", "failed", "cancelled"].includes(terminal.status));
  });
  if (!terminal) throw new Error(`run ${runId} was not found after completion`);
  if (terminal.status !== "completed") {
    throw new Error(`run ${runId} ended ${terminal.status}: ${terminal.error ?? "unknown error"}`);
  }
  return runId;
}

async function waitForDatabase(pred: () => Promise<boolean>) {
  const start = Date.now();
  while (Date.now() - start < 10_000) {
    if (await pred()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timeout waiting for database state");
}
