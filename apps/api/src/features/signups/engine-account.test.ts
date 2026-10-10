import type { PrismaClient } from "@superchat/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetEngineAccount, setEngineAccountSuspended } from "./engine-account.js";

const client = { baseUrl: "http://engine.test", proxySecret: "proxy", secrets: [], tenant: "s1" };
const deps = () => ({
  prisma: {
    user: { findUnique: vi.fn(async () => ({ email: "p@example.test" })) },
  } as unknown as PrismaClient,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function stub(handler: (url: URL, init?: RequestInit) => Response) {
  const fetchMock = vi.fn(async (url: URL, init?: RequestInit) => handler(url, init));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

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
