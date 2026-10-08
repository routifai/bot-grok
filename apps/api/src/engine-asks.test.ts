import type { PrismaClient } from "@nova/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { engineAnswerAsk, engineListAsks, isEngineAskId } from "./engine-asks.js";

const client = {
  baseUrl: "http://engine.test",
  proxySecret: "proxy",
  secrets: [],
  tenant: "space-1",
};
const actor = { userId: "user-1", spaceId: "space-1" } as never;

function deps(session: string | null = "sess-1") {
  return {
    prisma: {
      bot: { findFirst: vi.fn(async () => ({ id: "bot-1" })) },
      user: { findUnique: vi.fn(async () => ({ email: "p@example.test" })) },
      omnigentSession: {
        findUnique: vi.fn(async () => (session ? { omnigentSessionId: session } : null)),
      },
    } as unknown as PrismaClient,
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function stub(routes: Record<string, unknown>) {
  const fetchMock = vi.fn(async (url: URL, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    if (!(key in routes)) throw new Error(`unexpected ${key}`);
    const value = routes[key];
    return value instanceof Response ? value : json(value);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const approval = (id: string, sessionId: string, extra = {}) => ({
  id: `approval:${id}`,
  kind: "approval",
  session_id: sessionId,
  objective_id: null,
  created_at: 1_700_000_300,
  subject: {
    category: "send",
    targets: ["bob@acme.test"],
    summary: "Send an email to bob@acme.test",
    amount_usd: null,
    can_always: true,
    always_label: "Send messages to bob@acme.test",
    ...extra,
  },
  choices: [
    { id: "approve_once", style: "primary" },
    ...("can_always" in extra && !extra.can_always
      ? []
      : [{ id: "approve_always", style: "secondary" }]),
    { id: "deny", style: "danger" },
  ],
});

const proposal = (id: string, isFirstPlan: boolean, sessionId = "sess-1") => ({
  id: `proposal:obj-1:${id}`,
  kind: "plan_proposal",
  session_id: sessionId,
  objective_id: "obj-1",
  created_at: 1_700_000_200,
  subject: {
    objective_title: "Plan the offsite",
    reason: "Add a review step",
    is_first_plan: isFirstPlan,
    plan: [
      { id: null, title: "Pick a venue" },
      { id: null, title: "Book it" },
    ],
  },
  choices: [
    { id: "accept", style: "primary" },
    { id: "dismiss", style: "secondary" },
  ],
});

const blocked = {
  id: "task:obj-1:t1",
  kind: "blocked_task",
  session_id: "sess-1",
  objective_id: "obj-1",
  created_at: 1_700_000_100,
  subject: {
    objective_title: "Plan the offsite",
    task_id: "t1",
    title: "Pick a venue",
    note: "Which city?",
  },
  choices: [{ id: "answer", style: "primary" }],
};

const session = (id: string, kind: string, root: string) => ({
  id,
  status: "idle",
  superchat: { kind, root_id: root, parent_id: root, seed_item_id: null, project: null },
});

afterEach(() => vi.unstubAllGlobals());

describe("engine asks", () => {
  it("maps the engine's kinds and choice ids to Nova's copy", async () => {
    stub({
      "GET /v1/me/asks": {
        data: [
          approval("e1", "sess-1"),
          proposal("p-first", true),
          proposal("p-change", false),
          blocked,
        ],
      },
    });
    const asks = await engineListAsks(deps(), client, actor, "bot-1");
    expect(asks.map((ask) => [ask.kind, ask.id])).toEqual([
      ["approval", "approval:e1"],
      ["proposal", "proposal:obj-1:p-first"],
      ["proposal", "proposal:obj-1:p-change"],
      ["blocked_task", "task:obj-1:t1"],
    ]);
    expect(asks[0]).toMatchObject({
      runId: "sess-1",
      text: "Send an email to bob@acme.test",
      detail: "Always allow: Send messages to bob@acme.test",
      choices: [
        { id: "approve_once", label: "Allow once" },
        { id: "approve_always", label: "Always allow" },
        { id: "deny", label: "Deny" },
      ],
      approval: { chatId: null },
    });
    expect(asks[1]).toMatchObject({
      runId: "obj-1",
      goalId: "obj-1",
      goalTitle: "Plan the offsite",
      text: 'Here\'s my plan for "Plan the offsite"',
      detail: "1. Pick a venue\n2. Book it",
      choices: [
        { id: "accept", label: "Start this plan" },
        { id: "dismiss", label: "Not now" },
      ],
    });
    expect(asks[2]).toMatchObject({
      text: 'Change the plan for "Plan the offsite"?',
      detail: "Add a review step\n1. Pick a venue\n2. Book it",
      choices: [
        { id: "accept", label: "Use the new plan" },
        { id: "dismiss", label: "Keep current" },
      ],
    });
    expect(asks[3]).toMatchObject({ text: "Which city?", input: "text", choices: [] });
  });

  it("leaves out Always allow when the engine does", async () => {
    stub({ "GET /v1/me/asks": { data: [approval("e1", "sess-1", { can_always: false })] } });
    const [ask] = await engineListAsks(deps(), client, actor, "bot-1");
    expect(ask?.choices.map((choice) => choice.id)).toEqual(["approve_once", "deny"]);
    expect(ask?.detail).toBeUndefined();
  });

  it("keeps only this Muse's asks, and names the Side Chat an approval belongs to", async () => {
    stub({
      "GET /v1/me/asks": {
        data: [
          approval("side", "sess-side"),
          approval("helper", "sess-helper"),
          approval("other", "sess-other"),
          proposal("p-other", true, "sess-2"),
        ],
      },
      "GET /v1/sessions/sess-side": session("sess-side", "side", "sess-1"),
      "GET /v1/sessions/sess-helper": session("sess-helper", "helper", "sess-1"),
      "GET /v1/sessions/sess-other": session("sess-other", "side", "sess-2"),
    });
    const asks = await engineListAsks(deps(), client, actor, "bot-1");
    expect(asks.map((ask) => [ask.id, ask.approval?.chatId])).toEqual([
      ["approval:side", "sess-side"],
      ["approval:helper", null],
    ]);
  });

  it("has no asks before the Muse has a Conversation", async () => {
    const fetchMock = stub({});
    expect(await engineListAsks(deps(null), client, actor, "bot-1")).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers with the choice id, and a blocked Task with the reply as its note", async () => {
    const fetchMock = stub({
      "POST /v1/me/asks/approval%3Ae1/answer": { ok: true },
      "POST /v1/me/asks/task%3Aobj-1%3At1/answer": { ok: true },
    });
    await engineAnswerAsk(deps(), client, actor, {
      askId: "approval:e1",
      answer: "approve_always",
    });
    await engineAnswerAsk(deps(), client, actor, { askId: "task:obj-1:t1", answer: "Toronto" });
    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies).toEqual([{ choice: "approve_always" }, { choice: "answer", note: "Toronto" }]);
  });

  it("reports an ask that is no longer waiting as a conflict", async () => {
    stub({
      "POST /v1/me/asks/proposal%3Aobj-1%3Ap/answer": json(
        { error: { code: "conflict", message: "proposal is no longer open" } },
        409,
      ),
    });
    await expect(
      engineAnswerAsk(deps(), client, actor, { askId: "proposal:obj-1:p", answer: "accept" }),
    ).rejects.toThrow("This prompt is no longer awaiting an answer");
  });

  it("recognizes engine ask ids", () => {
    expect(isEngineAskId("approval:elicit_1")).toBe(true);
    expect(isEngineAskId("task:o:t")).toBe(true);
    expect(isEngineAskId("msg_123")).toBe(false);
  });
});
