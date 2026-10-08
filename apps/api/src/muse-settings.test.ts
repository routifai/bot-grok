import type { Actor } from "@aiden/contracts";
import type { PrismaClient } from "@aiden/db";
import { RPCHandler } from "@orpc/server/fetch";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMuseSettings, updateMuseSettings } from "./muse-settings.js";
import { createRouter, type RouterDeps } from "./router.js";

const actor: Actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@aiden.test",
  isDeploymentOwner: true,
};

type BotRow = { museProactivity: string | null; museQuietHours: string | null };

function museSettingsDeps(botRow: BotRow | null) {
  const findFirst = vi.fn().mockResolvedValue(botRow);
  const update = vi.fn().mockImplementation(
    async ({ data }: { data: Partial<BotRow> }): Promise<BotRow> => ({
      museProactivity: data.museProactivity ?? botRow?.museProactivity ?? null,
      museQuietHours: data.museQuietHours ?? botRow?.museQuietHours ?? null,
    }),
  );
  const prisma = { bot: { findFirst, update } } as unknown as PrismaClient;
  const deps = {
    prisma,
    env: {
      defaultProvider: "fake",
      defaultModel: "fake-model",
      webOrigin: "http://127.0.0.1:5173",
      screenProxySecret: "fake-test-secret",
      sandboxProvider: "fake",
    },
    dataDir: "/tmp/aiden-muse-settings-test",
  } as unknown as RouterDeps;
  return { findFirst, update, deps, handler: new RPCHandler(createRouter(deps)) };
}

async function getSettings(handler: RPCHandler<{ actor: Actor | null }>, botId: string) {
  return handler.handle(
    new Request("http://127.0.0.1/rpc/muse/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: { botId } }),
    }),
    { prefix: "/rpc", context: { actor } },
  );
}

async function updateSettings(
  handler: RPCHandler<{ actor: Actor | null }>,
  input: Record<string, unknown>,
) {
  return handler.handle(
    new Request("http://127.0.0.1/rpc/muse/updateSettings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: input }),
    }),
    { prefix: "/rpc", context: { actor } },
  );
}

describe("muse.settings", () => {
  it("returns DEFAULT_MUSE_SETTINGS when the bot has no settings saved", async () => {
    const { handler, findFirst } = museSettingsDeps({
      museProactivity: null,
      museQuietHours: null,
    });

    const { response } = await getSettings(handler, "bot-1");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      json: { proactivity: "normal", quietHours: "22:00-08:00" },
    });
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "bot-1", spaceId: "space-1", userId: "user-1" },
      select: { museProactivity: true, museQuietHours: true },
    });
  });

  it("returns saved settings, including quiet hours explicitly turned off", async () => {
    const { handler } = museSettingsDeps({ museProactivity: "high", museQuietHours: "" });

    const { response } = await getSettings(handler, "bot-1");

    await expect(response.json()).resolves.toEqual({
      json: { proactivity: "high", quietHours: null },
    });
  });

  it("rejects a bot outside the actor's space", async () => {
    const { handler, update } = museSettingsDeps(null);

    const { response } = await getSettings(handler, "someone-elses-bot");

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(update).not.toHaveBeenCalled();
  });
});

describe("muse.updateSettings", () => {
  it("updates only the given field, leaving the rest as saved", async () => {
    const { handler, update } = museSettingsDeps({
      museProactivity: "normal",
      museQuietHours: "22:00-08:00",
    });

    const { response } = await updateSettings(handler, { botId: "bot-1", proactivity: "low" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      json: { proactivity: "low", quietHours: "22:00-08:00" },
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: "bot-1" },
      data: { museProactivity: "low" },
      select: { museProactivity: true, museQuietHours: true },
    });
  });

  it("turns quiet hours off by storing the empty-string sentinel, not null", async () => {
    const { handler, update } = museSettingsDeps({
      museProactivity: "normal",
      museQuietHours: "22:00-08:00",
    });

    const { response } = await updateSettings(handler, { botId: "bot-1", quietHours: null });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      json: { proactivity: "normal", quietHours: null },
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: "bot-1" },
      data: { museQuietHours: "" },
      select: { museProactivity: true, museQuietHours: true },
    });
  });

  it("rejects a malformed quiet-hours string before it reaches the handler", async () => {
    const { handler, update } = museSettingsDeps({
      museProactivity: "normal",
      museQuietHours: null,
    });

    const { response } = await updateSettings(handler, {
      botId: "bot-1",
      quietHours: "not-a-time-range",
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects an unknown proactivity level", async () => {
    const { handler, update } = museSettingsDeps({
      museProactivity: "normal",
      museQuietHours: null,
    });

    const { response } = await updateSettings(handler, { botId: "bot-1", proactivity: "extreme" });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects updating a bot outside the actor's space", async () => {
    const { handler, update } = museSettingsDeps(null);

    const { response } = await updateSettings(handler, {
      botId: "someone-elses-bot",
      proactivity: "high",
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(update).not.toHaveBeenCalled();
  });
});

describe("Muse settings on the engine", () => {
  const ENV = { OMNIGENT_URL: "http://engine.test", OMNIGENT_PROXY_SECRET: "s" };
  const prefs = (extra = {}) => ({
    proactivity: "normal",
    quiet_start: null,
    quiet_end: null,
    timezone: "UTC",
    ...extra,
  });

  function engineDeps(bot: BotRow) {
    const update = vi.fn(async () => bot);
    const prisma = {
      bot: { findFirst: vi.fn(async () => bot), update },
      user: { findUnique: vi.fn(async () => ({ email: "user@aiden.test" })) },
    } as unknown as PrismaClient;
    return { deps: { prisma }, update };
  }

  function engine(current: Record<string, unknown>) {
    const fetchMock = vi.fn(async (_url: URL, init?: RequestInit) => {
      const body = init?.body ? { ...current, ...JSON.parse(String(init.body)) } : current;
      return new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  afterEach(() => vi.unstubAllGlobals());

  it("reads the engine's values, high and quiet hours included", async () => {
    const fetchMock = engine(
      prefs({ proactivity: "high", quiet_start: "21:00", quiet_end: "07:00" }),
    );
    const { deps, update } = engineDeps({ museProactivity: null, museQuietHours: null });

    await expect(getMuseSettings(deps, actor, "bot-1", ENV)).resolves.toEqual({
      proactivity: "high",
      quietHours: "21:00-07:00",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect((init.headers as Record<string, string>)["X-Omnigent-Tenant"]).toBe("space-1");
    expect(update).not.toHaveBeenCalled();
  });

  it("carries values set in Nova over once, when the engine still has its defaults", async () => {
    const fetchMock = engine(prefs());
    const { deps, update } = engineDeps({ museProactivity: "high", museQuietHours: "" });

    await expect(getMuseSettings(deps, actor, "bot-1", ENV)).resolves.toEqual({
      proactivity: "high",
      quietHours: null,
    });
    const [, init] = fetchMock.mock.calls[1] as unknown as [URL, RequestInit];
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({
      proactivity: "high",
      quiet_start: null,
      quiet_end: null,
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: "bot-1" },
      data: { museProactivity: null, museQuietHours: null },
    });
  });

  it("never overwrites values the person already set on the engine", async () => {
    const fetchMock = engine(prefs({ proactivity: "low" }));
    const { deps, update } = engineDeps({ museProactivity: "high", museQuietHours: null });

    await expect(getMuseSettings(deps, actor, "bot-1", ENV)).resolves.toEqual({
      proactivity: "low",
      quietHours: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledOnce();
  });

  it("writes only the changed field to the engine", async () => {
    const fetchMock = engine(prefs({ quiet_start: "22:00", quiet_end: "08:00" }));
    const { deps } = engineDeps({ museProactivity: null, museQuietHours: null });

    await expect(
      updateMuseSettings(deps, actor, { botId: "bot-1", proactivity: "high" }, ENV),
    ).resolves.toEqual({ proactivity: "high", quietHours: "22:00-08:00" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.pathname).toBe("/v1/me/proactivity");
    expect(JSON.parse(String(init.body))).toEqual({ proactivity: "high" });
  });
});
