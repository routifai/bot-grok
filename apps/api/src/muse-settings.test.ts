import type { Actor } from "@aiden/contracts";
import type { PrismaClient } from "@aiden/db";
import { RPCHandler } from "@orpc/server/fetch";
import { describe, expect, it, vi } from "vitest";
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
