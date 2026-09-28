import type { Actor } from "@aiden/contracts";
import { IsolationError, type PrismaClient } from "@aiden/db";
import { describe, expect, it, vi } from "vitest";
import { listEpisodes, type MuseEpisodesDeps, removeEpisode } from "./muse-episodes.js";

const actor: Actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@aiden.test",
  isDeploymentOwner: true,
};

const BOT_ID = "bot-1";
const OTHER_BOT_ID = "bot-2";

const EPISODE_ROW = {
  id: "episode-1",
  title: "Compared mortgage rates",
  summary: "Found the lowest 5-year fixed rate at RBC.",
  links: ["https://example.com/rates"],
  tools: ["web_fetch", "web_search"],
  botId: BOT_ID,
  goalId: null,
  createdAt: new Date("2026-09-20T00:00:00.000Z"),
};

function fakeDeps(options: { episodeRows?: (typeof EPISODE_ROW)[] } = {}) {
  const botFindFirst = vi.fn(
    async ({ where }: { where: { id: string; spaceId: string; userId: string } }) => {
      if (where.id !== BOT_ID || where.spaceId !== actor.spaceId || where.userId !== actor.userId) {
        return null;
      }
      return { id: BOT_ID, thread: null, computer: null };
    },
  );
  const episodeRows = options.episodeRows ?? [EPISODE_ROW];
  const episodeFindMany = vi.fn(async () => episodeRows);
  const episodeFindUnique = vi.fn(
    async ({ where }: { where: { id: string } }) =>
      episodeRows.find((row) => row.id === where.id) ?? null,
  );
  const episodeDeleteMany = vi.fn(async () => ({ count: 1 }));
  const prisma = {
    bot: { findFirst: botFindFirst },
    episode: {
      findMany: episodeFindMany,
      findUnique: episodeFindUnique,
      deleteMany: episodeDeleteMany,
    },
  } as unknown as PrismaClient;
  const deps: MuseEpisodesDeps = { prisma };
  return { deps, botFindFirst, episodeFindMany, episodeFindUnique, episodeDeleteMany };
}

describe("listEpisodes", () => {
  it("authorizes the bot, then reads its episodes newest first", async () => {
    const { deps, botFindFirst, episodeFindMany } = fakeDeps();
    const result = await listEpisodes(deps, actor, { botId: BOT_ID });
    expect(botFindFirst).toHaveBeenCalled();
    expect(episodeFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { botId: BOT_ID }, orderBy: { createdAt: "desc" } }),
    );
    expect(result).toEqual([
      {
        id: "episode-1",
        title: "Compared mortgage rates",
        summary: "Found the lowest 5-year fixed rate at RBC.",
        links: ["https://example.com/rates"],
        tools: ["web_fetch", "web_search"],
        goalId: null,
        createdAt: "2026-09-20T00:00:00.000Z",
      },
    ]);
  });

  it("defaults the limit to 50", async () => {
    const { deps, episodeFindMany } = fakeDeps();
    await listEpisodes(deps, actor, { botId: BOT_ID });
    expect(episodeFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 50 }));
  });

  it("throws IsolationError for a bot that isn't the actor's own", async () => {
    const { deps } = fakeDeps();
    await expect(listEpisodes(deps, actor, { botId: OTHER_BOT_ID })).rejects.toBeInstanceOf(
      IsolationError,
    );
  });
});

describe("removeEpisode", () => {
  it("removes an episode that belongs to the actor's own bot", async () => {
    const { deps, episodeDeleteMany } = fakeDeps();
    const result = await removeEpisode(deps, actor, "episode-1");
    expect(result).toEqual({ ok: true });
    expect(episodeDeleteMany).toHaveBeenCalledWith({ where: { id: "episode-1" } });
  });

  it("throws IsolationError for an episode on someone else's bot", async () => {
    const { deps } = fakeDeps({ episodeRows: [{ ...EPISODE_ROW, botId: OTHER_BOT_ID }] });
    await expect(removeEpisode(deps, actor, "episode-1")).rejects.toBeInstanceOf(IsolationError);
  });

  it("throws IsolationError for an episode that doesn't exist", async () => {
    const { deps } = fakeDeps({ episodeRows: [] });
    await expect(removeEpisode(deps, actor, "missing")).rejects.toBeInstanceOf(IsolationError);
  });
});
