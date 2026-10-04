import type { Actor, Idea } from "@aiden/contracts";
import { createIdeaRepos, createRepos, type PrismaClient } from "@aiden/db";

// B11 · Ideas (docs/muse/PLAN.md). Engine-backed Muses read their Ideas from the engine
// (engine-ideas.ts); this reads the stored batch the Pi-era refresh left behind. Authorizes
// like every other bot-scoped route: `createRepos(prisma).getBot` throws unless `botId` is
// one of this actor's own bots in their own Space.

export interface MuseIdeasDeps {
  prisma: PrismaClient;
}

export async function listIdeas(deps: MuseIdeasDeps, actor: Actor, botId: string): Promise<Idea[]> {
  await createRepos(deps.prisma).getBot(actor, botId);
  return createIdeaRepos(deps.prisma).listIdeas(botId);
}
