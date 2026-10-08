import type { PrismaClient } from "@nova/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  engineAcceptProposal,
  engineDismissProposal,
  engineGetGoal,
  engineGoalLog,
  engineListGoals,
  engineUpdateGoal,
} from "./engine-goals.js";

const client = {
  baseUrl: "http://engine.test",
  proxySecret: "proxy",
  secrets: ["sk-secret"],
  tenant: "space-1",
};
const actor = { userId: "user-1", spaceId: "space-1" } as never;

function deps({ session = "sess-1", owned = true } = {}) {
  const prisma = {
    bot: { findFirst: vi.fn(async () => ({ id: "bot-1" })) },
    user: { findUnique: vi.fn(async () => ({ email: "p@example.test" })) },
    omnigentSession: {
      findUnique: vi.fn(async () => (session ? { omnigentSessionId: session } : null)),
      findFirst: vi.fn(async () => (owned ? { botId: "bot-1" } : null)),
    },
  };
  return { prisma: prisma as unknown as PrismaClient };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const objective = (extra = {}) => ({
  id: "obj-1",
  parent_session_id: "sess-1",
  title: "Ship the approvals framework",
  description: "One page.",
  status: "active",
  due: "2026-10-17",
  scheduled_task_id: "task-1",
  created_at: 1_700_000_000,
  updated_at: 1_700_000_100,
  plan: [
    { id: "t1", title: "Draft outline", status: "done", note: null },
    { id: "t2", title: "Write the page", status: "in_progress", note: "half way" },
  ],
  open_proposal: null,
  ...extra,
});

const proposal = (extra = {}) => ({
  id: "prop-1",
  reason: "Add a review step",
  plan: [
    { id: "t1", title: "Draft outline" },
    { id: null, title: "Review with compliance" },
  ],
  status: "open",
  created_at: 1_700_000_200,
  ...extra,
});

const task = (extra = {}) => ({
  id: "task-1",
  name: "Goal: Ship",
  prompt: "",
  rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=7;BYMINUTE=30",
  timezone: "America/Toronto",
  state: "active",
  parent_session_id: "sess-1",
  agent_type: "goal",
  last_run_at: 1_700_000_300,
  next_run_at: "2026-10-05T11:30:00+00:00",
  ...extra,
});

function stub(routes: Record<string, unknown | ((init?: RequestInit, url?: URL) => unknown)>) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (url: URL, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    calls.push(key);
    const route = routes[key];
    if (route === undefined) throw new Error(`unexpected ${key}`);
    const body = typeof route === "function" ? route(init, url) : route;
    return body instanceof Response ? body : json(body);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

afterEach(() => vi.unstubAllGlobals());

describe("engine goals", () => {
  it("lists active and paused objectives in the Goal shape, with the cadence", async () => {
    stub({
      "GET /v1/objectives": {
        objectives: [
          objective(),
          objective({ id: "obj-2", status: "archived", scheduled_task_id: null }),
        ],
      },
      "GET /v1/scheduled-tasks": { scheduled_tasks: [task()] },
    });
    const goals = await engineListGoals(deps(), client, actor, { botId: "bot-1" });
    expect(goals).toHaveLength(1);
    expect(goals[0]).toEqual({
      id: "obj-1",
      botId: "bot-1",
      title: "Ship the approvals framework",
      description: "One page.",
      status: "active",
      due: "2026-10-17",
      checkInCrons: ["30 7 * * 1-5"],
      timezone: "America/Toronto",
      tasks: [
        {
          id: "t1",
          goalId: "obj-1",
          idx: 0,
          title: "Draft outline",
          status: "done",
          note: "",
          updatedAt: "2023-11-14T22:15:00.000Z",
        },
        {
          id: "t2",
          goalId: "obj-1",
          idx: 1,
          title: "Write the page",
          status: "in_progress",
          note: "half way",
          updatedAt: "2023-11-14T22:15:00.000Z",
        },
      ],
      openProposal: null,
      lastWorkedAt: "2023-11-14T22:18:20.000Z",
      nextWorkAt: "2026-10-05T11:30:00+00:00",
      createdAt: "2023-11-14T22:13:20.000Z",
      updatedAt: "2023-11-14T22:15:00.000Z",
    });
  });

  it("includes closed Goals on request and maps archived to cancelled", async () => {
    stub({
      "GET /v1/objectives": { objectives: [objective({ status: "archived" })] },
      "GET /v1/scheduled-tasks": { scheduled_tasks: [] },
    });
    const goals = await engineListGoals(deps(), client, actor, {
      botId: "bot-1",
      includeClosed: true,
    });
    expect(goals.map((goal) => goal.status)).toEqual(["cancelled"]);
  });

  it("is empty while the Muse has no Conversation", async () => {
    expect(await engineListGoals(deps({ session: "" }), client, actor, { botId: "bot-1" })).toEqual(
      [],
    );
  });

  it("maps an open first-plan proposal, keeping task identity", async () => {
    stub({
      "GET /v1/objectives/obj-1": objective({ plan: [], open_proposal: proposal() }),
      "GET /v1/scheduled-tasks/task-1": task({ rrule: "FREQ=DAILY" }),
    });
    const goal = await engineGetGoal(deps(), client, actor, "obj-1");
    expect(goal.checkInCrons).toEqual([]);
    expect(goal.openProposal).toEqual({
      id: "prop-1",
      goalId: "obj-1",
      reason: "Add a review step",
      tasks: [{ title: "Draft outline", keepTaskId: "t1" }, { title: "Review with compliance" }],
      status: "open",
      createdAt: "2023-11-14T22:16:40.000Z",
    });
  });

  it("treats another person's objective as not found", async () => {
    stub({ "GET /v1/objectives/obj-1": objective() });
    await expect(engineGetGoal(deps({ owned: false }), client, actor, "obj-1")).rejects.toThrow(
      /Goal not found/,
    );
    stub({
      "GET /v1/objectives/obj-1": json({ error: { code: "not_found", message: "no" } }, 404),
    });
    await expect(engineGetGoal(deps(), client, actor, "obj-1")).rejects.toThrow(/Goal not found/);
  });

  it("moves status on the engine: cancel archives, pause pauses", async () => {
    const { calls, fetchMock } = stub({
      "GET /v1/objectives/obj-1": objective(),
      "PATCH /v1/objectives/obj-1": (init?: RequestInit) =>
        objective({ status: JSON.parse(String(init?.body)).status }),
      "GET /v1/scheduled-tasks/task-1": task(),
    });
    const goal = await engineUpdateGoal(deps(), client, actor, {
      goalId: "obj-1",
      status: "cancelled",
    });
    expect(goal.status).toBe("cancelled");
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ status: "archived" });
    expect(calls).toContain("PATCH /v1/objectives/obj-1");
  });

  it("changes the check-in by rewriting the cadence task's schedule", async () => {
    let rrule = "";
    stub({
      "GET /v1/objectives/obj-1": objective(),
      "PATCH /v1/scheduled-tasks/task-1": (init?: RequestInit) => {
        rrule = JSON.parse(String(init?.body)).rrule;
        return task({ rrule });
      },
      "GET /v1/scheduled-tasks/task-1": () => task({ rrule }),
    });
    const goal = await engineUpdateGoal(deps(), client, actor, {
      goalId: "obj-1",
      checkInCrons: ["0 9 * * 1"],
    });
    expect(rrule).toBe("FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0");
    expect(goal.checkInCrons).toEqual(["0 9 * * 1"]);
  });

  it("refuses a check-in the engine schedule cannot express, or on a Goal with no schedule", async () => {
    stub({ "GET /v1/objectives/obj-1": objective() });
    await expect(
      engineUpdateGoal(deps(), client, actor, { goalId: "obj-1", checkInCrons: ["*/5 * * * *"] }),
    ).rejects.toThrow(/hourly, daily, weekly or monthly/);
    stub({ "GET /v1/objectives/obj-1": objective({ scheduled_task_id: null }) });
    await expect(
      engineUpdateGoal(deps(), client, actor, { goalId: "obj-1", checkInCrons: ["0 9 * * *"] }),
    ).rejects.toThrow(/hourly, daily, weekly or monthly/);
  });

  it("accepts and dismisses a proposal on the engine", async () => {
    const { calls } = stub({
      "GET /v1/objectives/obj-1": objective({ open_proposal: proposal() }),
      "POST /v1/objectives/obj-1/proposals/prop-1/accept": objective(),
      "POST /v1/objectives/obj-1/proposals/prop-1/dismiss": objective(),
      "GET /v1/scheduled-tasks/task-1": task(),
    });
    const input = { goalId: "obj-1", proposalId: "prop-1" };
    expect((await engineAcceptProposal(deps(), client, actor, input)).openProposal).toBeNull();
    await engineDismissProposal(deps(), client, actor, input);
    expect(calls).toContain("POST /v1/objectives/obj-1/proposals/prop-1/accept");
    expect(calls).toContain("POST /v1/objectives/obj-1/proposals/prop-1/dismiss");
  });

  it("reports a proposal that is no longer open as a conflict", async () => {
    stub({
      "GET /v1/objectives/obj-1": objective(),
      "POST /v1/objectives/obj-1/proposals/prop-1/accept": json(
        { error: { code: "conflict", message: "closed" } },
        409,
      ),
    });
    await expect(
      engineAcceptProposal(deps(), client, actor, { goalId: "obj-1", proposalId: "prop-1" }),
    ).rejects.toThrow(/no longer open/);
  });

  it("renders finished runs as markdown messages, oldest first, secrets redacted", async () => {
    stub({
      "GET /v1/objectives/obj-1": objective(),
      "GET /v1/objectives/obj-1/log": {
        log: [
          entry("r3", "running", null, null),
          entry("r2", "succeeded", "**Done**: used sk-secret here", 1_700_000_500),
          entry("r1", "succeeded", "Outline drafted.", 1_700_000_400),
          entry("r0", "skipped", null, null),
        ],
      },
    });
    const page = await engineGoalLog(deps(), client, actor, "obj-1");
    expect(page.olderCursor).toBeNull();
    expect(page.messages.map((message) => message.id)).toEqual(["r1", "r2"]);
    expect(page.messages[1]?.blocks).toEqual([
      { kind: "text", text: "**Done**: used [redacted] here" },
    ]);
    expect(page.messages[0]?.createdAt).toBe("2023-11-14T22:20:00.000Z");
  });
});

function entry(run_id: string, status: string, result: string | null, finished: number | null) {
  return {
    run_id,
    status,
    scheduled_at: 1_700_000_000,
    fired_at: finished,
    finished_at: finished,
    error_code: null,
    attempt: 1,
    conversation_id: result ? `conv-${run_id}` : null,
    result,
  };
}
