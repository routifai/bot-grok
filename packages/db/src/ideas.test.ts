import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { createIdeaRepos, mapIdea } from "./ideas.js";

const baseRow = {
  id: "idea-1",
  text: "Quiz me on today's 10 Japanese phrases",
  area: "learning",
  detail: "I'll ask you today's 10 phrases and check your answers.",
  illustration: "books" as const,
  createdAt: new Date("2026-09-20T00:00:00.000Z"),
};

describe("mapIdea", () => {
  it("maps a row to the contract shape", () => {
    expect(mapIdea(baseRow)).toEqual({
      id: "idea-1",
      text: "Quiz me on today's 10 Japanese phrases",
      area: "learning",
      detail: "I'll ask you today's 10 phrases and check your answers.",
      illustration: "books",
      createdAt: "2026-09-20T00:00:00.000Z",
    });
  });

  it("maps null detail and illustration through unchanged (pre-migration rows)", () => {
    expect(mapIdea({ ...baseRow, detail: null, illustration: null })).toMatchObject({
      detail: null,
      illustration: null,
    });
  });
});

type CreateManyArgs = {
  data: Array<{
    spaceId: string;
    userId: string;
    botId: string;
    text: string;
    area: string;
    detail: string | null;
    illustration: string | null;
    createdAt: Date;
  }>;
};

describe("createIdeaRepos", () => {
  function reposFor(rows: unknown[]) {
    const idea = {
      findMany: vi.fn(async () => rows),
      deleteMany: vi.fn(async () => ({ count: rows.length })),
      createMany: vi.fn(async (_args: CreateManyArgs) => ({ count: 0 })),
    };
    const prisma = {
      idea,
      $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback({ idea })),
    };
    return { repos: createIdeaRepos(prisma as unknown as PrismaClient), prisma, idea };
  }

  it("listIdeas reads a Muse's ideas oldest first", async () => {
    const { repos, idea } = reposFor([baseRow]);
    const result = await repos.listIdeas("bot-1");
    expect(result).toEqual([mapIdea(baseRow)]);
    expect(idea.findMany).toHaveBeenCalledWith({
      where: { botId: "bot-1" },
      orderBy: { createdAt: "asc" },
    });
  });

  it("replaceIdeas deletes the previous batch and inserts the new one wholesale", async () => {
    const { repos, idea } = reposFor([baseRow]);
    const drafts = [
      {
        text: "Plan this Sunday's long run route",
        area: "health",
        detail: "I can lay out a 10K route and a pace to hit your goal time.",
        illustration: "trophy" as const,
      },
      { text: "Draft a landing page for my portfolio", area: "creative" },
    ];
    const result = await repos.replaceIdeas(
      { botId: "bot-1", spaceId: "space-1", userId: "user-1" },
      drafts,
    );

    expect(idea.deleteMany).toHaveBeenCalledWith({ where: { botId: "bot-1" } });
    expect(idea.createMany).toHaveBeenCalledTimes(1);
    const createArgs = idea.createMany.mock.calls[0]![0];
    expect(createArgs.data).toHaveLength(2);
    expect(createArgs.data[0]).toMatchObject({
      spaceId: "space-1",
      userId: "user-1",
      botId: "bot-1",
      text: drafts[0]!.text,
      area: "health",
      detail: drafts[0]!.detail,
      illustration: "trophy",
    });
    // A draft with no detail/illustration (e.g. from an older model output) defaults to null.
    expect(createArgs.data[1]).toMatchObject({ detail: null, illustration: null });
    // Explicit createdAt offsets preserve draft order across a single-transaction insert.
    expect(createArgs.data[0]!.createdAt.getTime()).toBeLessThan(
      createArgs.data[1]!.createdAt.getTime(),
    );
    expect(result).toEqual([mapIdea(baseRow)]);
  });

  it("replaceIdeas with no drafts clears the previous batch and inserts nothing", async () => {
    const { repos, idea } = reposFor([]);
    const result = await repos.replaceIdeas(
      { botId: "bot-1", spaceId: "space-1", userId: "user-1" },
      [],
    );
    expect(idea.deleteMany).toHaveBeenCalledWith({ where: { botId: "bot-1" } });
    expect(idea.createMany).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });
});
