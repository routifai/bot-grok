import type { PrismaClient } from "@aiden/db";
import { describe, expect, it, vi } from "vitest";
import { recallEpisodesFromTool, recordEpisode } from "./episodes.js";

describe("recordEpisode", () => {
  const run = {
    id: "run-1",
    spaceId: "s",
    userId: "u",
    botId: "b",
    threadId: "t",
    trigger: "user",
  };

  function fakeDeps(toolNames: string[]) {
    const upsert = vi.fn(
      async (_args: { where: { runId: string }; create: Record<string, unknown> }) => ({
        id: "episode-1",
      }),
    );
    const prisma: Record<string, unknown> = {
      event: { findMany: vi.fn(async () => toolNames.map((name) => ({ payload: { name } }))) },
      episode: { upsert },
    };
    return { deps: { prisma: prisma as unknown as PrismaClient }, upsert };
  }

  it("records an episode when a work tool was used and the reply is real", async () => {
    const { deps, upsert } = fakeDeps(["web_search", "web_fetch"]);
    const wrote = await recordEpisode(deps, run, {
      request: "Compare mortgage rates",
      reply: "RBC has the lowest 5-year fixed rate at 5.04%.",
    });
    expect(wrote).toBe(true);
    expect(upsert).toHaveBeenCalledTimes(1);
    const call = upsert.mock.calls[0]![0];
    expect(call.where).toEqual({ runId: "run-1" });
    expect(call.create).toMatchObject({
      runId: "run-1",
      spaceId: "s",
      userId: "u",
      botId: "b",
      threadId: "t",
      trigger: "user",
      title: "Compare mortgage rates",
      tools: ["web_fetch", "web_search"],
    });
    expect(call.create.goalId).toBeNull();
  });

  it("passes goalId through when the run carries one", async () => {
    const { deps, upsert } = fakeDeps(["web_search"]);
    await recordEpisode(deps, { ...run, goalId: "goal-1" }, { request: "r", reply: "reply" });
    expect(upsert.mock.calls[0]?.[0].create.goalId).toBe("goal-1");
  });

  it("does not record when no work tool was used", async () => {
    const { deps, upsert } = fakeDeps(["remember", "scratchpad_add"]);
    const wrote = await recordEpisode(deps, run, { request: "r", reply: "some reply" });
    expect(wrote).toBe(false);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("does not record an empty reply", async () => {
    const { deps, upsert } = fakeDeps(["web_search"]);
    expect(await recordEpisode(deps, run, { request: "r", reply: "   " })).toBe(false);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("does not record an exact NO_RESPONSE reply", async () => {
    const { deps, upsert } = fakeDeps(["web_search"]);
    expect(await recordEpisode(deps, run, { request: "r", reply: "NO_RESPONSE" })).toBe(false);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("upserts by runId so a resumed run does not duplicate", async () => {
    const { deps, upsert } = fakeDeps(["web_search"]);
    await recordEpisode(deps, run, { request: "r", reply: "reply one" });
    await recordEpisode(deps, run, { request: "r", reply: "reply two" });
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert.mock.calls[0]?.[0].where).toEqual({ runId: "run-1" });
    expect(upsert.mock.calls[1]?.[0].where).toEqual({ runId: "run-1" });
  });
});

describe("recallEpisodesFromTool", () => {
  function fakeDeps(
    rows: Array<{ title: string; summary: string; links: string[]; createdAt: Date }>,
  ) {
    const findMany = vi.fn(async () => rows);
    const prisma: Record<string, unknown> = { episode: { findMany } };
    return { deps: { prisma: prisma as unknown as PrismaClient }, findMany };
  }

  const rows = [
    {
      title: "Compared mortgage rates",
      summary: "Found the lowest 5-year fixed rate at RBC.",
      links: ["https://example.com/rates"],
      createdAt: new Date("2026-09-14T00:00:00Z"),
    },
    {
      title: "Booked a dentist appointment",
      summary: "Scheduled for next Tuesday.",
      links: [],
      createdAt: new Date("2026-09-10T00:00:00Z"),
    },
  ];

  it("returns ranked matches for a matching query", async () => {
    const { deps } = fakeDeps(rows);
    const result = await recallEpisodesFromTool(deps, { botId: "b" }, { query: "mortgage rate" });
    expect(result.episodes).toEqual([
      {
        date: "2026-09-14",
        title: "Compared mortgage rates",
        summary: "Found the lowest 5-year fixed rate at RBC.",
        links: ["https://example.com/rates"],
      },
    ]);
    expect(result.note).toBeUndefined();
  });

  it("falls back to the most recent episodes with a note when nothing matches", async () => {
    const { deps } = fakeDeps(rows);
    const result = await recallEpisodesFromTool(deps, { botId: "b" }, { query: "zzz nomatch" });
    expect(result.episodes).toHaveLength(2);
    expect(result.note).toContain("No episodes matched");
  });

  it("notes when there are no past episodes at all", async () => {
    const { deps } = fakeDeps([]);
    const result = await recallEpisodesFromTool(deps, { botId: "b" }, { query: "anything" });
    expect(result.episodes).toEqual([]);
    expect(result.note).toBe("No past episodes yet.");
  });

  it("clamps limit to 1-10", async () => {
    const { deps, findMany } = fakeDeps(rows);
    await recallEpisodesFromTool(deps, { botId: "b" }, { query: "mortgage", limit: 999 });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { botId: "b" }, take: 1000 }),
    );
  });
});
