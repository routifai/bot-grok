import type { PrismaClient } from "@nova/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listApprovalRules, revokeApprovalRule, setApprovalSpending } from "./service.js";

const client = {
  baseUrl: "http://engine.test",
  proxySecret: "proxy",
  secrets: [],
  tenant: "space-1",
};
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

afterEach(() => vi.unstubAllGlobals());

describe("engine approvals", () => {
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
