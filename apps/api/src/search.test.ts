import type { Actor } from "@aiden/contracts";
import type { PrismaClient } from "@aiden/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { querySpaceSearch } from "./search.js";

const actor: Actor = { spaceId: "space-test", userId: "user-test" };

function fixture(count: number) {
  const artifacts = Array.from({ length: count }, (_, index) => ({
    id: `artifact-${index}`,
    botId: `bot-${index}`,
    bot: { name: "Bot" },
    name: "report.txt",
    mimeType: "text/plain",
    size: 10,
  }));
  const groupArtifacts = artifacts.map((artifact) => ({
    ...artifact,
    id: `group-${artifact.id}`,
    botId: null,
    bot: null,
    groupId: "group-test",
    group: { name: "Group" },
  }));
  const prisma = {
    bot: { findMany: vi.fn().mockResolvedValue([]) },
    chatGroup: { findMany: vi.fn().mockResolvedValue([]) },
    artifact: {
      findMany: vi.fn().mockResolvedValueOnce(artifacts).mockResolvedValueOnce(groupArtifacts),
    },
    routine: { findMany: vi.fn().mockResolvedValue([]) },
    $queryRaw: vi.fn().mockResolvedValue([]),
  };
  return { prisma, artifacts, groupArtifacts };
}

describe("artifact search batching", () => {
  it.each([1, 25])("uses one lookup per destination for %i matching artifacts", async (count) => {
    const { prisma } = fixture(count);
    await querySpaceSearch(prisma as unknown as PrismaClient, actor, "report");
    // Two artifact batches and the existing direct/group message searches.
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(4);
    const direct = prisma.$queryRaw.mock.calls[0]?.[0];
    const group = prisma.$queryRaw.mock.calls[1]?.[0];
    expect(direct.text).toContain('t."botId" = candidate."targetId"');
    expect(group.text).toContain('t."groupId" = candidate."targetId"');
    for (const query of [direct, group]) {
      expect(query.values).toContain(actor.spaceId);
      expect(query.values).toContain(actor.userId);
      expect(query.text).toContain('ORDER BY m."createdAt" DESC');
    }
  });

  it("preserves artifact priority and skips missing messages regardless of batch row order", async () => {
    const { prisma } = fixture(3);
    prisma.$queryRaw
      .mockResolvedValueOnce([
        { artifactId: "artifact-2", id: "message-2", seq: 8 },
        { artifactId: "artifact-0", id: "message-0", seq: 6 },
      ])
      .mockResolvedValueOnce([{ artifactId: "group-artifact-1", id: "group-message", seq: 3 }]);
    const hits = await querySpaceSearch(prisma as unknown as PrismaClient, actor, "report");
    expect(hits.map(({ artifactId, messageId, seq }) => ({ artifactId, messageId, seq }))).toEqual([
      { artifactId: "artifact-0", messageId: "message-0", seq: 6 },
      { artifactId: "artifact-2", messageId: "message-2", seq: 8 },
      { artifactId: "group-artifact-1", messageId: "group-message", seq: 3 },
    ]);
  });

  it("does not issue artifact queries for empty batches", async () => {
    const { prisma } = fixture(0);
    expect(await querySpaceSearch(prisma as unknown as PrismaClient, actor, "report")).toEqual([]);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });
});

describe("engine-backed Conversation search", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("finds a Muse's messages in the engine, by the transcript's message id, and skips Nova's copies", async () => {
    const { prisma } = fixture(0);
    const withSession = {
      ...prisma,
      omnigentSession: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ omnigentSessionId: "sess-1", bot: { id: "bot-1", name: "Nova" } }]),
      },
    };
    const fetchMock = vi.fn(async () =>
      Response.json({
        data: [
          {
            id: "item-9",
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "The quarterly report is ready." }],
          },
          { id: "call-1", type: "function_call" },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const hits = await querySpaceSearch(withSession as unknown as PrismaClient, actor, "report", {
      client: { baseUrl: "http://engine.test", proxySecret: "p" },
      email: "p@example.test",
    });

    expect(hits).toEqual([
      expect.objectContaining({ kind: "message", botId: "bot-1", messageId: "item-9" }),
    ]);
    const [url] = fetchMock.mock.calls[0] as unknown as [URL];
    expect(String(url)).toBe(
      "http://engine.test/v1/sessions/sess-1/items/search?query=report&limit=10",
    );
    // Nova's own message rows are left out for a Muse the engine holds.
    const messageQuery = withSession.$queryRaw.mock.calls.find(
      ([q]) => Array.isArray(q) && q.join("").includes("INNER JOIN bots b"),
    );
    expect(messageQuery).toBeDefined();
    expect(JSON.stringify(messageQuery)).toContain("omnigent_sessions");
  });
});
