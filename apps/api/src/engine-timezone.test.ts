import { afterEach, describe, expect, it, vi } from "vitest";
import { syncEngineTimezone } from "./engine-timezone.js";

const ACTOR = { userId: "u1", spaceId: "space-1" };
const env = { OMNIGENT_URL: "http://engine.test", OMNIGENT_PROXY_SECRET: "s" } as NodeJS.ProcessEnv;

function prismaWith(user: { email: string; timezone: string | null } | null) {
  return { user: { findUnique: vi.fn().mockResolvedValue(user) } } as never;
}

afterEach(() => vi.unstubAllGlobals());

describe("syncEngineTimezone", () => {
  it("puts the person's timezone into the engine's preferences", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await syncEngineTimezone(
      prismaWith({ email: "a@example.com", timezone: "America/Toronto" }),
      ACTOR,
      env,
    );
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe("http://engine.test/v1/me/proactivity");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ timezone: "America/Toronto" });
    expect((init.headers as Record<string, string>)["X-Omnigent-Tenant"]).toBe("space-1");
  });

  it("does nothing without an engine connection or a timezone, and never throws", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("down"));
    vi.stubGlobal("fetch", fetchMock);
    await syncEngineTimezone(prismaWith({ email: "a@example.com", timezone: "UTC" }), ACTOR, {});
    await syncEngineTimezone(prismaWith({ email: "a@example.com", timezone: null }), ACTOR, env);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(
      syncEngineTimezone(prismaWith({ email: "a@example.com", timezone: "UTC" }), ACTOR, env),
    ).resolves.toBeUndefined();
  });
});
