import { afterEach, expect, it, vi } from "vitest";
import { listVault, saveVaultEntry } from "./service.js";

const env = { OMNIGENT_URL: "http://engine.test", OMNIGENT_PROXY_SECRET: "k" } as NodeJS.ProcessEnv;
const actor = { userId: "u1", spaceId: "s1" } as never;
const deps = {
  prisma: {
    bot: { findFirst: async () => ({ id: "b1" }) },
    user: { findUnique: async () => ({ email: "a@b.test" }) },
  },
} as never;

afterEach(() => vi.unstubAllGlobals());

it("relays a saved login without ever returning or leaking the password", async () => {
  const fetchMock = vi.fn(async (_url: URL, init?: RequestInit) =>
    init?.method === "POST"
      ? new Response(JSON.stringify({ detail: [{ input: "hunter2" }] }), { status: 422 })
      : new Response(
          JSON.stringify({
            entries: [
              {
                id: "v1",
                name: "acme",
                site: "https://acme.test",
                username: "ann",
                created_at: 1,
                last_used_at: null,
              },
            ],
          }),
        ),
  );
  vi.stubGlobal("fetch", fetchMock);
  const listed = await listVault(deps, actor, { botId: "b1" }, env);
  expect(listed.entries[0]).toMatchObject({ name: "acme", lastUsedAt: null });
  expect(JSON.stringify(listed)).not.toContain("hunter2");
  const failure = await saveVaultEntry(
    deps,
    actor,
    { botId: "b1", name: "acme", site: "https://acme.test", password: "hunter2" },
    env,
  ).catch((error: Error) => error);
  expect(String(failure)).not.toContain("hunter2");
});
