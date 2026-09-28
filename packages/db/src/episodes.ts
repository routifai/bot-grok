import type { Episode } from "@aiden/contracts";
import type { PrismaClient } from "./client.js";

// Repository for Episode (episodic memory: CONTEXT.md "Episode"). Mirrors the pattern in
// feed.ts's createTopicRepos: a plain list, a get-by-id used to authorize a remove by the
// episode's own bot, and a remove.

interface EpisodeRow {
  id: string;
  title: string;
  summary: string;
  links: string[];
  tools: string[];
  goalId: string | null;
  createdAt: Date;
}

export function mapEpisode(row: EpisodeRow): Episode {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    links: row.links,
    tools: row.tools,
    goalId: row.goalId,
    createdAt: row.createdAt.toISOString(),
  };
}

export function createEpisodeRepos(prisma: PrismaClient) {
  return {
    /** A Muse's episodes, newest first. */
    async listEpisodes(botId: string, limit: number): Promise<Episode[]> {
      const rows = await prisma.episode.findMany({
        where: { botId },
        orderBy: { createdAt: "desc" },
        take: limit,
      });
      return rows.map(mapEpisode);
    },

    /** One episode with its owning bot, or null. Used to authorize a remove. */
    async getEpisode(episodeId: string): Promise<(Episode & { botId: string }) | null> {
      const row = await prisma.episode.findUnique({ where: { id: episodeId } });
      return row ? { ...mapEpisode(row), botId: row.botId } : null;
    },

    /** Forgets an episode by id. A no-op (not an error) if it's already gone. */
    async removeEpisode(episodeId: string): Promise<void> {
      await prisma.episode.deleteMany({ where: { id: episodeId } });
    },
  };
}
