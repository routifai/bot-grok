import type { Actor, Episode } from "@aiden/contracts";
import { createEpisodeRepos, createRepos, IsolationError, type PrismaClient } from "@aiden/db";

// Episodic memory (CONTEXT.md "Episode"): episodes.list / episodes.remove. Authorized the
// same way every other bot-scoped route is: `createRepos(prisma).getBot` throws unless
// `botId` is one of this actor's own bots in their own Space (mirrors muse-feed.ts).

export interface MuseEpisodesDeps {
  prisma: PrismaClient;
}

const DEFAULT_EPISODES_LIMIT = 50;

export async function listEpisodes(
  deps: MuseEpisodesDeps,
  actor: Actor,
  input: { botId: string; limit?: number },
): Promise<Episode[]> {
  await createRepos(deps.prisma).getBot(actor, input.botId);
  return createEpisodeRepos(deps.prisma).listEpisodes(
    input.botId,
    input.limit ?? DEFAULT_EPISODES_LIMIT,
  );
}

/** The episode's own bot must belong to the actor, like every other bot-scoped route. */
export async function removeEpisode(
  deps: MuseEpisodesDeps,
  actor: Actor,
  episodeId: string,
): Promise<{ ok: true }> {
  const episodes = createEpisodeRepos(deps.prisma);
  const episode = await episodes.getEpisode(episodeId);
  if (!episode) throw new IsolationError();
  await createRepos(deps.prisma).getBot(actor, episode.botId);
  await episodes.removeEpisode(episodeId);
  return { ok: true as const };
}
