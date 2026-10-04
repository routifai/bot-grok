import type { Actor } from "@aiden/contracts";
import { IsolationError, type PrismaClient } from "@aiden/db";
import { describe, expect, it, vi } from "vitest";
import { listIdeas, type MuseIdeasDeps } from "./muse-ideas.js";

const actor: Actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@aiden.test",
  isDeploymentOwner: true,
};

const BOT_ID = "bot-1";

const IDEA_ROW = {
  id: "idea-1",
  text: "Quiz me on today's 10 Japanese phrases",
  area: "learning",
  createdAt: new Date("2026-09-20T00:00:00.000Z"),
};

function fakeDeps(options: { botExists?: boolean; ideaRows?: (typeof IDEA_ROW)[] } = {}) {
  const botFindFirst = vi.fn(
    async ({ where }: { where: { id: string; spaceId: string; userId: string } }) => {
      if (options.botExists === false) return null;
      if (where.id !== BOT_ID || where.spaceId !== actor.spaceId || where.userId !== actor.userId) {
        return null;
      }
      return { id: BOT_ID, thread: null, computer: null };
    },
  );
  const ideaFindMany = vi.fn(async () => options.ideaRows ?? [IDEA_ROW]);
  const prisma = {
    bot: { findFirst: botFindFirst },
    idea: { findMany: ideaFindMany },
  } as unknown as PrismaClient;
  const deps: MuseIdeasDeps = { prisma };
  return { deps, botFindFirst, ideaFindMany };
}

describe("listIdeas", () => {
  it("authorizes against the actor's own bot before reading", async () => {
    const { deps, botFindFirst } = fakeDeps();
    await listIdeas(deps, actor, BOT_ID);
    expect(botFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: BOT_ID, spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
      }),
    );
  });

  it("throws when the bot isn't this actor's own", async () => {
    const { deps } = fakeDeps({ botExists: false });
    await expect(listIdeas(deps, actor, BOT_ID)).rejects.toBeInstanceOf(IsolationError);
  });

  it("returns the stored ideas", async () => {
    const { deps } = fakeDeps();
    const result = await listIdeas(deps, actor, BOT_ID);
    expect(result).toEqual([
      {
        id: "idea-1",
        text: "Quiz me on today's 10 Japanese phrases",
        area: "learning",
        createdAt: "2026-09-20T00:00:00.000Z",
      },
    ]);
  });

  it("returns an empty list when there are no ideas yet", async () => {
    const { deps } = fakeDeps({ ideaRows: [] });
    expect(await listIdeas(deps, actor, BOT_ID)).toEqual([]);
  });
});
