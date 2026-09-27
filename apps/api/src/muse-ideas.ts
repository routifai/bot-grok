import type { AgentRunRequest, AgentRuntime, JobPublisher, MemoryStore } from "@aiden/adapter-kit";
import { ideasRefreshJob } from "@aiden/adapter-kit";
import { refreshIdeas } from "@aiden/adapters";
import type { Actor, Idea } from "@aiden/contracts";
import { createIdeaRepos, createRepos, type PrismaClient } from "@aiden/db";

// B11 · Ideas (docs/muse/PLAN.md). `ideas.list` reads the stored batch, enqueueing a
// background refresh the first time there's nothing to show yet; `ideas.refresh` runs
// the one model call immediately and returns its result. Both authorize the same way
// every other bot-scoped route does: `createRepos(prisma).getBot` throws unless `botId`
// is one of this actor's own bots in their own Space.

export interface MuseIdeasDeps {
  prisma: PrismaClient;
  runtime: AgentRuntime;
  memory: MemoryStore;
  jobs: JobPublisher;
  deploymentModelKey?: string;
  resolveModel?: (scope: {
    userId: string;
    spaceId: string;
    botId?: string;
  }) => Promise<AgentRunRequest["model"]>;
}

export async function listIdeas(deps: MuseIdeasDeps, actor: Actor, botId: string): Promise<Idea[]> {
  await createRepos(deps.prisma).getBot(actor, botId);
  const ideas = await createIdeaRepos(deps.prisma).listIdeas(botId);
  if (ideas.length === 0) {
    // Nothing to show yet (a brand-new Muse): kick off a refresh in the background
    // rather than making this read wait on a model call.
    await deps.jobs.enqueue(ideasRefreshJob(botId)).catch(() => undefined);
  }
  return ideas;
}

export async function refreshIdeasNow(
  deps: MuseIdeasDeps,
  actor: Actor,
  botId: string,
): Promise<Idea[]> {
  await createRepos(deps.prisma).getBot(actor, botId);
  return refreshIdeas(
    {
      prisma: deps.prisma,
      runtime: deps.runtime,
      memory: deps.memory,
      deploymentModelKey: deps.deploymentModelKey,
      ...(deps.resolveModel ? { resolveModel: deps.resolveModel } : {}),
    },
    botId,
  );
}
