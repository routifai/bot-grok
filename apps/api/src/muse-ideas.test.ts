import type { AgentRuntime, JobPublisher, MemoryStore } from "@aiden/adapter-kit";
import type { Actor } from "@aiden/contracts";
import { IsolationError, type PrismaClient } from "@aiden/db";
import { describe, expect, it, vi } from "vitest";
import { listIdeas, type MuseIdeasDeps, refreshIdeasNow } from "./muse-ideas.js";

const refreshIdeasMock = vi.fn(async () => [
  {
    id: "idea-fresh",
    text: "Plan the Kyoto trip",
    area: "travel",
    createdAt: "2026-09-27T00:00:00.000Z",
  },
]);

vi.mock("@aiden/adapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aiden/adapters")>();
  return { ...actual, refreshIdeas: (...args: unknown[]) => refreshIdeasMock(...args) };
});

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
  const jobs = { enqueue: vi.fn(async () => undefined) } as unknown as JobPublisher;
  const prisma = {
    bot: { findFirst: botFindFirst },
    idea: { findMany: ideaFindMany },
  } as unknown as PrismaClient;
  const deps: MuseIdeasDeps = {
    prisma,
    runtime: {} as unknown as AgentRuntime,
    memory: {} as unknown as MemoryStore,
    jobs,
    deploymentModelKey: "openrouter-key",
  };
  return { deps, botFindFirst, ideaFindMany, jobs };
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

  it("returns the stored ideas without enqueueing a refresh", async () => {
    const { deps, jobs } = fakeDeps();
    const result = await listIdeas(deps, actor, BOT_ID);
    expect(result).toEqual([
      {
        id: "idea-1",
        text: "Quiz me on today's 10 Japanese phrases",
        area: "learning",
        createdAt: "2026-09-20T00:00:00.000Z",
      },
    ]);
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });

  it("enqueues a background refresh and returns an empty list when there are no ideas yet", async () => {
    const { deps, jobs } = fakeDeps({ ideaRows: [] });
    const result = await listIdeas(deps, actor, BOT_ID);
    expect(result).toEqual([]);
    expect(jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "ideas.refresh", payload: { botId: BOT_ID } }),
    );
  });
});

describe("refreshIdeasNow", () => {
  it("authorizes, then runs refreshIdeas with this Muse's deps and returns its result", async () => {
    refreshIdeasMock.mockClear();
    const { deps, botFindFirst } = fakeDeps();

    const result = await refreshIdeasNow(deps, actor, BOT_ID);

    expect(botFindFirst).toHaveBeenCalledOnce();
    expect(refreshIdeasMock).toHaveBeenCalledWith(
      {
        prisma: deps.prisma,
        runtime: deps.runtime,
        memory: deps.memory,
        deploymentModelKey: "openrouter-key",
      },
      BOT_ID,
    );
    expect(result).toEqual([
      {
        id: "idea-fresh",
        text: "Plan the Kyoto trip",
        area: "travel",
        createdAt: "2026-09-27T00:00:00.000Z",
      },
    ]);
  });

  it("throws when the bot isn't this actor's own, without running refreshIdeas", async () => {
    refreshIdeasMock.mockClear();
    const { deps } = fakeDeps({ botExists: false });

    await expect(refreshIdeasNow(deps, actor, BOT_ID)).rejects.toBeInstanceOf(IsolationError);
    expect(refreshIdeasMock).not.toHaveBeenCalled();
  });
});
