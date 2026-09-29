import type { MemorySnapshot, MemoryStore } from "@aiden/adapter-kit";
import type { PrismaClient } from "@aiden/db";
import { describe, expect, it, vi } from "vitest";
import { composeOmnigentContext } from "./context-provider.js";

const BOT = {
  id: "bot-1",
  userId: "user-1",
  spaceId: "space-1",
  name: "muse",
  title: "The Muse",
  description: "Personal AI",
  instructions: "Be helpful.",
};

const MEMORY_CANARY = "CANARY-DURABLE-MEMORY-SHOULD-NOT-LEAK";
const GOAL_CANARY = "CANARY-GOAL-SHOULD-NOT-LEAK";
const SCRATCHPAD_CANARY = "CANARY-SCRATCHPAD-SHOULD-NOT-LEAK";
const EPISODE_CANARY = "CANARY-EPISODE-SHOULD-NOT-LEAK";

function emptySnapshot(): MemorySnapshot {
  return { documents: [] };
}

function fakeMemory(overrides?: Partial<MemoryStore>): MemoryStore {
  return {
    read: vi.fn(async () => emptySnapshot()),
    ...overrides,
  } as unknown as MemoryStore;
}

function fakePrisma(overrides?: Record<string, unknown>): PrismaClient {
  const base = {
    bot: { findUnique: vi.fn(async () => BOT) },
    user: {
      findUnique: vi.fn(async () => ({ timezone: "America/Toronto", email: "sam@nova.test" })),
    },
    taughtSkill: { findMany: vi.fn(async () => []) },
    agentSkill: { findMany: vi.fn(async () => []) },
    episode: { findMany: vi.fn(async () => []) },
    goal: { findMany: vi.fn(async () => []) },
    scratchpadItem: { findMany: vi.fn(async () => []) },
  };
  return { ...base, ...overrides } as unknown as PrismaClient;
}

const PRIVATE_LABELS = {
  "nova.user": "user-1",
  "nova.space": "space-1",
  "nova.bot": "bot-1",
  "nova.scope": "private",
};

describe("composeOmnigentContext", () => {
  it("returns the static Muse voice/goals instructions plus the bot's own identity", async () => {
    const result = await composeOmnigentContext(
      { prisma: fakePrisma(), memory: fakeMemory(), secrets: [] },
      { labels: PRIVATE_LABELS, turnInput: "hello" },
    );
    expect(result).toContain("Be helpful.");
    expect(result).toContain("How you reply");
    expect(result).toContain("Use the goals tool");
  });

  it("includes durable memory, scratchpad, goals and episodes for a private scope", async () => {
    const memory = fakeMemory({
      read: vi.fn(async ({ scope }: { scope: "bot" | "user" }) =>
        scope === "bot"
          ? {
              documents: [
                {
                  id: "notes",
                  path: "notes.md",
                  content: MEMORY_CANARY,
                  revision: 1,
                  updatedAt: "2026-09-01T00:00:00.000Z",
                },
              ],
            }
          : emptySnapshot(),
      ),
    });
    const prisma = fakePrisma({
      goal: {
        findMany: vi.fn(async () => [
          {
            id: "goal-1",
            botId: "bot-1",
            title: GOAL_CANARY,
            description: "",
            status: "active",
            due: null,
            checkInCrons: [],
            timezone: "UTC",
            tasks: [],
            proposals: [],
            createdAt: new Date(),
            updatedAt: new Date(),
            lastWorkedAt: null,
            nextWorkAt: null,
          },
        ]),
      },
      scratchpadItem: {
        findMany: vi.fn(async () => [
          {
            id: "item-1",
            title: SCRATCHPAD_CANARY,
            notes: "",
            status: "open",
            updatedAt: new Date(),
            createdAt: new Date(),
          },
        ]),
      },
      episode: {
        findMany: vi.fn(async () => [
          {
            title: `hello ${EPISODE_CANARY}`,
            summary: EPISODE_CANARY,
            links: [],
            createdAt: new Date(),
          },
        ]),
      },
    });

    const result = await composeOmnigentContext(
      { prisma, memory, secrets: [] },
      { labels: PRIVATE_LABELS, turnInput: "hello" },
    );

    expect(result).toContain(MEMORY_CANARY);
    expect(result).toContain(GOAL_CANARY);
    expect(result).toContain(SCRATCHPAD_CANARY);
    expect(result).toContain(EPISODE_CANARY);
    expect(result).toContain("America/Toronto");
  });

  it("redacts configured secrets from every private context block", async () => {
    const secret = "sk-super-secret-value";
    const memory = fakeMemory({
      read: vi.fn(async ({ scope }: { scope: "bot" | "user" }) =>
        scope === "bot"
          ? {
              documents: [
                {
                  id: "notes",
                  path: "notes.md",
                  content: `token is ${secret}`,
                  revision: 1,
                  updatedAt: "2026-09-01T00:00:00.000Z",
                },
              ],
            }
          : emptySnapshot(),
      ),
    });
    const result = await composeOmnigentContext(
      { prisma: fakePrisma(), memory, secrets: [secret] },
      { labels: PRIVATE_LABELS, turnInput: "hello" },
    );
    expect(result).not.toContain(secret);
    expect(result).toContain("[redacted]");
  });

  it("isolation: a non-private scope never sees memory, goals, scratchpad, or episodes", async () => {
    const memory = fakeMemory({
      read: vi.fn(async ({ scope }: { scope: "bot" | "user" }) =>
        scope === "bot"
          ? {
              documents: [
                {
                  id: "notes",
                  path: "notes.md",
                  content: MEMORY_CANARY,
                  revision: 1,
                  updatedAt: "2026-09-01T00:00:00.000Z",
                },
              ],
            }
          : emptySnapshot(),
      ),
    });
    const prisma = fakePrisma({
      goal: {
        findMany: vi.fn(async () => [
          {
            id: "goal-1",
            botId: "bot-1",
            title: GOAL_CANARY,
            description: "",
            status: "active",
            due: null,
            checkInCrons: [],
            timezone: "UTC",
            tasks: [],
            proposals: [],
            createdAt: new Date(),
            updatedAt: new Date(),
            lastWorkedAt: null,
            nextWorkAt: null,
          },
        ]),
      },
      scratchpadItem: {
        findMany: vi.fn(async () => [
          {
            id: "item-1",
            title: SCRATCHPAD_CANARY,
            notes: "",
            status: "open",
            updatedAt: new Date(),
            createdAt: new Date(),
          },
        ]),
      },
      episode: {
        findMany: vi.fn(async () => [
          { title: EPISODE_CANARY, summary: EPISODE_CANARY, links: [], createdAt: new Date() },
        ]),
      },
    });

    const result = await composeOmnigentContext(
      { prisma, memory, secrets: [] },
      { labels: { ...PRIVATE_LABELS, "nova.scope": "project" }, turnInput: "hello" },
    );

    expect(result).not.toContain(MEMORY_CANARY);
    expect(result).not.toContain(GOAL_CANARY);
    expect(result).not.toContain(SCRATCHPAD_CANARY);
    expect(result).not.toContain(EPISODE_CANARY);
    expect(prisma.goal.findMany).not.toHaveBeenCalled();
    expect(prisma.scratchpadItem.findMany).not.toHaveBeenCalled();
    expect(prisma.episode.findMany).not.toHaveBeenCalled();
    expect(memory.read).not.toHaveBeenCalled();
    // Still gets the static voice/goals instructions and its own bot identity.
    expect(result).toContain("Be helpful.");
    expect(result).toContain("How you reply");
  });

  it("returns empty instructions for labels missing the bot/user/space triple", async () => {
    const result = await composeOmnigentContext(
      { prisma: fakePrisma(), memory: fakeMemory(), secrets: [] },
      { labels: { "nova.scope": "private" }, turnInput: "hi" },
    );
    expect(result).toBe("");
  });

  it("returns empty instructions when the bot does not belong to that user/space", async () => {
    const prisma = fakePrisma({
      bot: { findUnique: vi.fn(async () => ({ ...BOT, spaceId: "some-other-space" })) },
    });
    const result = await composeOmnigentContext(
      { prisma, memory: fakeMemory(), secrets: [] },
      { labels: PRIVATE_LABELS, turnInput: "hi" },
    );
    expect(result).toBe("");
  });

  it("returns context when the server-resolved owner is the labelled person", async () => {
    const result = await composeOmnigentContext(
      { prisma: fakePrisma(), memory: fakeMemory(), secrets: [] },
      { labels: PRIVATE_LABELS, turnInput: "hi", ownerEmail: "SAM@nova.test" },
    );
    expect(result).not.toBe("");
  });

  it("returns empty instructions when the session owner is someone else", async () => {
    const result = await composeOmnigentContext(
      { prisma: fakePrisma(), memory: fakeMemory(), secrets: [] },
      { labels: PRIVATE_LABELS, turnInput: "hi", ownerEmail: "someone-else@nova.test" },
    );
    expect(result).toBe("");
  });

  it("returns empty instructions for an unknown bot id", async () => {
    const prisma = fakePrisma({ bot: { findUnique: vi.fn(async () => null) } });
    const result = await composeOmnigentContext(
      { prisma, memory: fakeMemory(), secrets: [] },
      { labels: PRIVATE_LABELS, turnInput: "hi" },
    );
    expect(result).toBe("");
  });

  it("caps the composed instructions at 48 KB", async () => {
    const memory = fakeMemory({
      read: vi.fn(async ({ scope }: { scope: "bot" | "user" }) =>
        scope === "bot"
          ? {
              documents: [
                {
                  id: "notes",
                  path: "notes.md",
                  content: "x".repeat(200_000),
                  revision: 1,
                  updatedAt: "2026-09-01T00:00:00.000Z",
                },
              ],
            }
          : emptySnapshot(),
      ),
    });
    const result = await composeOmnigentContext(
      { prisma: fakePrisma(), memory, secrets: [] },
      { labels: PRIVATE_LABELS, turnInput: "hello" },
    );
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(48 * 1024);
  });
});
