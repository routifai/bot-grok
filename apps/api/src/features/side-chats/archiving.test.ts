import type { Actor } from "@nova/contracts";
import type { PrismaClient } from "@nova/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getArchiving, updateArchiving } from "./archiving.js";

const actor: Actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@nova.test",
  isDeploymentOwner: true,
};
const ENV = { OMNIGENT_URL: "http://engine.test", OMNIGENT_PROXY_SECRET: "s" };

function depsFor(bot: { id: string } | null) {
  const findFirst = vi.fn(async () => bot);
  const prisma = {
    bot: { findFirst },
    user: { findUnique: vi.fn(async () => ({ email: "user@nova.test" })) },
  } as unknown as PrismaClient;
  return { deps: { prisma }, findFirst };
}

function engine(stored: number | null) {
  const saved = (days: unknown) => ({
    side_chat_auto_archive_days: days === "default" ? 30 : days,
    default_days: 30,
  });
  const fetchMock = vi.fn(async (_url: URL, init?: RequestInit) => {
    const body = init?.body
      ? saved(JSON.parse(String(init.body)).side_chat_auto_archive_days)
      : saved(stored);
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Muse archiving on the engine", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads the engine's effective value and the default", async () => {
    const fetchMock = engine(30);
    const { deps, findFirst } = depsFor({ id: "bot-1" });

    await expect(getArchiving(deps, actor, "bot-1", ENV)).resolves.toEqual({
      sideChatAutoArchiveDays: 30,
      defaultDays: 30,
    });
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "bot-1", spaceId: "space-1", userId: "user-1" },
      select: { id: true },
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.pathname).toBe("/v1/me/archiving");
    expect((init.headers as Record<string, string>)["X-Omnigent-Tenant"]).toBe("space-1");
  });

  it("writes the days to the engine and returns what it saved", async () => {
    const fetchMock = engine(null);
    const { deps } = depsFor({ id: "bot-1" });

    await expect(
      updateArchiving(deps, actor, { botId: "bot-1", sideChatAutoArchiveDays: 7 }, ENV),
    ).resolves.toEqual({ sideChatAutoArchiveDays: 7, defaultDays: 30 });
    const [, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({ side_chat_auto_archive_days: 7 });
  });

  it('sends null for never and "default" to forget the choice', async () => {
    const fetchMock = engine(null);
    const { deps } = depsFor({ id: "bot-1" });

    await expect(
      updateArchiving(deps, actor, { botId: "bot-1", sideChatAutoArchiveDays: null }, ENV),
    ).resolves.toEqual({ sideChatAutoArchiveDays: null, defaultDays: 30 });
    await expect(
      updateArchiving(deps, actor, { botId: "bot-1", sideChatAutoArchiveDays: "default" }, ENV),
    ).resolves.toEqual({ sideChatAutoArchiveDays: 30, defaultDays: 30 });
    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies).toEqual([
      { side_chat_auto_archive_days: null },
      { side_chat_auto_archive_days: "default" },
    ]);
  });

  it("rejects a bot outside the actor's space without calling the engine", async () => {
    const fetchMock = engine(null);
    const { deps } = depsFor(null);

    await expect(getArchiving(deps, actor, "someone-elses", ENV)).rejects.toThrow();
    await expect(
      updateArchiving(deps, actor, { botId: "someone-elses", sideChatAutoArchiveDays: 1 }, ENV),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads never and refuses to write without an engine", async () => {
    const { deps } = depsFor({ id: "bot-1" });

    await expect(getArchiving(deps, actor, "bot-1", {})).resolves.toEqual({
      sideChatAutoArchiveDays: null,
      defaultDays: 30,
    });
    await expect(
      updateArchiving(deps, actor, { botId: "bot-1", sideChatAutoArchiveDays: 30 }, {}),
    ).rejects.toThrow();
  });
});
