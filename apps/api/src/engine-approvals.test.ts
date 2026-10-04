import type { PrismaClient } from "@aiden/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  engineAnswerApproval,
  engineApprovalAsks,
  listApprovalRules,
  revokeApprovalRule,
  setApprovalSpending,
} from "./engine-approvals.js";

const client = { baseUrl: "http://engine.test", proxySecret: "proxy", secrets: [] };
const actor = { userId: "user-1", spaceId: "space-1" } as never;
const deps = {
  prisma: {
    bot: { findFirst: vi.fn(async () => ({ id: "bot-1" })) },
    user: { findUnique: vi.fn(async () => ({ email: "p@example.test" })) },
    omnigentSession: { findUnique: vi.fn(async () => ({ omnigentSessionId: "sess-1" })) },
  } as unknown as PrismaClient,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const waiting = (extra = {}) => ({
  id: "elicit_1",
  session_id: "sess-1",
  category: "send",
  targets: ["bob@acme.test"],
  summary: "Send an email to bob@acme.test",
  amount_usd: null,
  can_always: true,
  always_label: "Send messages to bob@acme.test",
  created_at: 1_700_000_000,
  ...extra,
});

afterEach(() => vi.unstubAllGlobals());

describe("engine approvals", () => {
  it("shows a waiting approval as an approval Ask with once / always / deny", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ approvals: [waiting()] })),
    );
    const [ask] = await engineApprovalAsks(deps, client, actor, "bot-1");
    expect(ask).toMatchObject({
      id: "elicit_1",
      runId: "sess-1",
      kind: "approval",
      text: "Send an email to bob@acme.test",
      detail: "Always allow: Send messages to bob@acme.test",
      approval: { chatId: null },
    });
    expect(ask?.choices.map((choice) => choice.id)).toEqual(["once", "always", "deny"]);
  });

  it("leaves out Always allow when the engine says it cannot apply", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ approvals: [waiting({ category: "spend", can_always: false })] })),
    );
    const [ask] = await engineApprovalAsks(deps, client, actor, "bot-1");
    expect(ask?.choices.map((choice) => choice.id)).toEqual(["once", "deny"]);
    expect(ask?.detail).toBeUndefined();
  });

  it("answers through the engine and ignores ids that are not approvals", async () => {
    const fetchMock = vi.fn(async () => json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    expect(
      await engineAnswerApproval(deps, client, actor, {
        askId: "elicit_1",
        runId: "sess-1",
        answer: "always",
      }),
    ).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.pathname).toBe("/v1/me/approvals/elicit_1/answer");
    expect(JSON.parse(String(init.body))).toEqual({ decision: "always" });
    expect(
      await engineAnswerApproval(deps, client, actor, {
        askId: "goal-proposal",
        runId: "g",
        answer: "accept",
      }),
    ).toBeNull();
  });

  it("lists rules with the spending cap, revokes a rule and sets the cap", async () => {
    const fetchMock = vi.fn(async (url: URL, init?: RequestInit) => {
      if (url.pathname === "/v1/me/approval-rules" && !init?.method) {
        return json({
          rules: [
            {
              id: "r1",
              category: "send",
              target: "*@acme.test",
              label: "Send messages to *@acme.test",
              decision: "allow",
              created_at: 5,
            },
          ],
        });
      }
      if (url.pathname === "/v1/me/approval-settings") {
        return json({ daily_cap_usd: init?.method === "PUT" ? 25 : 0, spent_today_usd: 0 });
      }
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await listApprovalRules(deps, client, actor, "bot-1")).toEqual({
      rules: [{ id: "r1", label: "Send messages to *@acme.test", decision: "allow", createdAt: 5 }],
      spending: { dailyCapUsd: 0, spentTodayUsd: 0 },
    });
    await revokeApprovalRule(deps, client, actor, { botId: "bot-1", ruleId: "r1" });
    expect(
      await setApprovalSpending(deps, client, actor, { botId: "bot-1", dailyCapUsd: 25 }),
    ).toEqual({
      dailyCapUsd: 25,
      spentTodayUsd: 0,
    });
  });
});
