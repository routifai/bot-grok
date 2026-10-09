import type { PrismaClient } from "@nova/db";
import type { ORPCError } from "@orpc/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectEngineModel } from "../models/index.js";
import {
  deleteEngineUser,
  listAdminUsers,
  resetEngineAccount,
  setEngineAccountSuspended,
  setUserSuspended,
} from "./service.js";

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

describe("suspension", () => {
  function nova(users: Array<{ id: string; email: string }>) {
    const d = deps();
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const findMany = vi.fn(async ({ where }: { where: { email: { equals: string } } }) =>
      users.filter((user) => user.email.toLowerCase() === where.email.equals.toLowerCase()),
    );
    (d.prisma as unknown as { user: object }).user = { ...d.prisma.user, findMany, updateMany };
    return { d, updateMany };
  }

  it("also suspends and restores the Nova account, matched by the engine's email id", async () => {
    stub(() => json({ user_id: "p", is_admin: true, ok: true }));
    const { d, updateMany } = nova([{ id: "nova-9", email: "Bob@Acme.test" }]);
    await setUserSuspended(d, client, actor, { userId: "bob@acme.test", suspended: true });
    expect(updateMany).toHaveBeenLastCalledWith({
      where: { id: "nova-9", status: "active" },
      data: { status: "suspended" },
    });
    await setUserSuspended(d, client, actor, { userId: "bob@acme.test", suspended: false });
    expect(updateMany).toHaveBeenLastCalledWith({
      where: { id: "nova-9", status: "suspended" },
      data: { status: "active" },
    });
  });

  it("refuses when no single account matches, rather than guess", async () => {
    stub(() => json({ user_id: "p", is_admin: true, ok: true }));
    const none = nova([]);
    expect(
      (
        await rejection(
          setUserSuspended(none.d, client, actor, { userId: "x@acme.test", suspended: true }),
        )
      ).code,
    ).toBe("NOT_FOUND");
    const twice = nova([
      { id: "a", email: "x@acme.test" },
      { id: "b", email: "X@acme.test" },
    ]);
    await rejection(
      setUserSuspended(twice.d, client, actor, { userId: "x@acme.test", suspended: true }),
    );
    expect(none.updateMany).not.toHaveBeenCalled();
    expect(twice.updateMany).not.toHaveBeenCalled();
  });
});

describe("engine account pause and reset (quarantine)", () => {
  function ownerDeps(owner: string | null) {
    const d = deps();
    Object.assign(d.prisma, {
      deploymentSettings: { findUnique: vi.fn(async () => ({ ownerUserId: owner })) },
      user: {
        findUnique: vi.fn(async () => (owner ? { email: "root@acme.test" } : null)),
      },
    });
    return d;
  }

  it("uses the deployment owner as the engine admin to pause, resume and reset", async () => {
    const fetchMock = stub(() => json({ user_id: "root", is_admin: true, ok: true }));
    const d = ownerDeps("owner-1");
    expect(await setEngineAccountSuspended(d, client, "squatter@acme.test", true)).toBe("done");
    expect(await resetEngineAccount(d, client, "squatter@acme.test")).toBe("done");
    const calls = fetchMock.mock.calls.map(
      ([url, init]) =>
        `${(init as RequestInit | undefined)?.method ?? "GET"} ${(url as URL).pathname}`,
    );
    expect(calls).toContain("POST /v1/admin/users/squatter%40acme.test/suspend");
    expect(calls).toContain("DELETE /v1/admin/users/squatter%40acme.test");
  });

  it("says so when there is no engine or no owner, rather than failing quietly", async () => {
    expect(await setEngineAccountSuspended(ownerDeps("o"), undefined, "a@acme.test", true)).toBe(
      "no-engine",
    );
    expect(await resetEngineAccount(ownerDeps(null), client, "a@acme.test")).toBe("no-owner");
    expect(await setEngineAccountSuspended(ownerDeps(null), client, "a@acme.test", true)).toBe(
      "no-owner",
    );
  });

  it("throws when the engine refuses (the owner is not an engine admin)", async () => {
    stub(() => json({ error: "forbidden" }, 403));
    await expect(
      setEngineAccountSuspended(ownerDeps("owner-1"), client, "a@acme.test", true),
    ).rejects.toThrow();
  });
});
