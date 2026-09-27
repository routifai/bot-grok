import type { Idea } from "@aiden/contracts";
import type { PrismaClient } from "./client.js";

// Repository for Idea (CONTEXT.md "Idea"; docs/muse/PLAN.md B11). Ideas are always
// replaced wholesale on refresh (`refreshIdeas`, packages/adapters/src/muse/ideas.ts):
// there is no partial update, so the repo exposes only "list" and "replace all".

interface IdeaRow {
  id: string;
  text: string;
  area: string;
  createdAt: Date;
}

export function mapIdea(row: IdeaRow): Idea {
  return {
    id: row.id,
    text: row.text,
    area: row.area,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface IdeaDraft {
  text: string;
  area: string;
}

export function createIdeaRepos(prisma: PrismaClient) {
  return {
    /** A Muse's Ideas, oldest first (the order the model suggested them in). */
    async listIdeas(botId: string): Promise<Idea[]> {
      const rows = await prisma.idea.findMany({ where: { botId }, orderBy: { createdAt: "asc" } });
      return rows.map(mapIdea);
    },

    /**
     * Replace every one of a Muse's Ideas with a fresh batch, in one transaction. Explicit
     * per-row `createdAt` offsets preserve the model's suggested order: every insert in one
     * transaction otherwise shares the same `now()`, and the contract has no separate
     * ordering field (CONTEXT.md "Idea" lists only id/text/area/createdAt).
     */
    async replaceIdeas(
      scope: { botId: string; spaceId: string; userId: string },
      drafts: IdeaDraft[],
    ): Promise<Idea[]> {
      return prisma.$transaction(async (tx) => {
        await tx.idea.deleteMany({ where: { botId: scope.botId } });
        if (drafts.length === 0) return [];
        const now = Date.now();
        await tx.idea.createMany({
          data: drafts.map((draft, index) => ({
            spaceId: scope.spaceId,
            userId: scope.userId,
            botId: scope.botId,
            text: draft.text,
            area: draft.area,
            createdAt: new Date(now + index),
          })),
        });
        const rows = await tx.idea.findMany({
          where: { botId: scope.botId },
          orderBy: { createdAt: "asc" },
        });
        return rows.map(mapIdea);
      });
    },
  };
}
