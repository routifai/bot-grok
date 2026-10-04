import { afterEach, describe, expect, it, vi } from "vitest";
import { syncEngineProactivity, syncEngineTimezone } from "./engine-timezone.js";

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
      "u1",
      env,
    );
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe("http://engine.test/v1/me/proactivity");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ timezone: "America/Toronto" });
  });

  it("does nothing without an engine connection or a timezone, and never throws", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("down"));
    vi.stubGlobal("fetch", fetchMock);
    await syncEngineTimezone(prismaWith({ email: "a@example.com", timezone: "UTC" }), "u1", {});
    await syncEngineTimezone(prismaWith({ email: "a@example.com", timezone: null }), "u1", env);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(
      syncEngineTimezone(prismaWith({ email: "a@example.com", timezone: "UTC" }), "u1", env),
    ).resolves.toBeUndefined();
  });
});

describe("syncEngineProactivity", () => {
  const body = async (settings: Parameters<typeof syncEngineProactivity>[2]) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await syncEngineProactivity(
      prismaWith({ email: "a@example.com", timezone: null }),
      "u1",
      settings,
      env,
    );
    return JSON.parse((fetchMock.mock.calls[0] as [URL, RequestInit])[1].body as string);
  };

  it("puts the level and quiet hours into the engine's preferences", async () => {
    expect(await body({ proactivity: "low", quietHours: "22:00-08:00" })).toEqual({
      proactivity: "low",
      quiet_start: "22:00",
      quiet_end: "08:00",
    });
  });

  it("clears quiet hours and runs high at the engine's top level", async () => {
    expect(await body({ proactivity: "high", quietHours: null })).toEqual({
      proactivity: "normal",
      quiet_start: null,
      quiet_end: null,
    });
  });
});
