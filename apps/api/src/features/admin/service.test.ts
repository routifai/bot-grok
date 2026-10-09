import type { PrismaClient } from "@nova/db";
import type { ORPCError } from "@orpc/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectEngineModel } from "../models/index.js";
import { deleteEngineUser, listAdminUsers } from "./service.js";

const client = { baseUrl: "http://engine.test", proxySecret: "proxy", secrets: [], tenant: "s1" };
const actor = { userId: "user-1", spaceId: "s1" } as never;
const deps = (agentName: string | null = "nova-pi") => ({
  prisma: {
    user: { findUnique: vi.fn(async () => ({ email: "p@example.test" })) },
    bot: {
      findFirst: vi.fn(async () => ({
        omnigentSession: agentName ? { omnigentSessionId: "sess-1", agentName } : null,
      })),
    },
    omnigentSession: { findFirst: vi.fn(async () => (agentName ? { agentName } : null)) },
  } as unknown as PrismaClient,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function stub(handler: (url: URL, init?: RequestInit) => Response) {
  const fetchMock = vi.fn(async (url: URL, init?: RequestInit) => handler(url, init));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function rejection(promise: Promise<unknown>): Promise<ORPCError<string, { code: string }>> {
  try {
    await promise;
  } catch (error) {
    return error as ORPCError<string, { code: string }>;
  }
  throw new Error("expected a rejection");
}

afterEach(() => vi.unstubAllGlobals());

describe("admin gating", () => {
  it("refuses a person the engine does not count as an admin, before any admin call", async () => {
    const fetchMock = stub(() => json({ user_id: "p", is_admin: false }));
    const error = await rejection(listAdminUsers(deps(), client, actor));
    expect(error.code).toBe("FORBIDDEN");
    expect(error.data).toEqual({ code: "forbidden" });
    expect(fetchMock.mock.calls.map(([url]) => (url as URL).pathname)).toEqual(["/v1/me"]);
    await rejection(deleteEngineUser(deps(), client, actor, "x@example.test"));
    await rejection(
      connectEngineModel(deps(), client, actor, { provider: "anthropic", apiKey: "k" }, "org"),
    );
    expect(fetchMock.mock.calls.every(([url]) => (url as URL).pathname === "/v1/me")).toBe(true);
  });

  it("maps the users the engine lists for an admin", async () => {
    stub((url) =>
      url.pathname === "/v1/me"
        ? json({ user_id: "a", is_admin: true })
        : json({
            users: [
              {
                id: "bob@example.test",
                email: "bob@example.test",
                is_admin: false,
                status: "suspended",
                spend_month_usd: 3.5,
                spend_today_usd: 0.5,
                session_count: 4,
                model_connections: [{ provider: "openrouter", hint: "...1", status: "valid" }],
                budget: { monthly_limit_usd: 20, at_limit: "ask" },
                computer: { name: "c", state: "online", managed: true },
                last_active: 100,
              },
            ],
          }),
    );
    expect(await listAdminUsers(deps(), client, actor)).toEqual([
      {
        id: "bob@example.test",
        email: "bob@example.test",
        isAdmin: false,
        status: "suspended",
        spendMonthUsd: 3.5,
        spendTodayUsd: 0.5,
        sessionCount: 4,
        providers: ["openrouter"],
        budget: { monthlyLimitUsd: 20, atLimit: "ask" },
        computer: "online",
        lastActive: 100,
      },
    ]);
  });
});
