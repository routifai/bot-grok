import type { AgentRunRequest, AgentRuntime, MemoryStore } from "@aiden/adapter-kit";
import type { MessageBlock } from "@aiden/contracts";
import type { PrismaClient } from "@aiden/db";
import { describe, expect, it, vi } from "vitest";
import { IDEAS_COUNT, parseIdeasCompletion, refreshIdeas } from "./ideas.js";

const previousIdeaRow = {
  id: "idea-old",
  text: "Old suggestion",
  area: "misc",
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
};

type HarnessMessage = { seq: number; role: string; blocks: MessageBlock[] };

function ideasHarness(
  options: {
    deploymentModelKey?: string;
    settings?: { defaultModelProvider: string | null; defaultModelId: string | null } | null;
    resolveModel?: (scope: {
      userId: string;
      spaceId: string;
      botId?: string;
    }) => Promise<AgentRunRequest["model"]>;
    completion?: string;
    runtimeCapableOfCompaction?: boolean;
    thread?: { id: string; historyCompactionSummary: string | null } | null;
    messages?: HarnessMessage[];
    goals?: unknown[];
    previousIdeas?: (typeof previousIdeaRow)[];
    memoryDocuments?: Array<{ id: string; path: string; content: string; revision: number }>;
  } = {},
) {
  const thread =
    options.thread === undefined
      ? { id: "thread-1", historyCompactionSummary: "Earlier the person asked about Kyoto." }
      : options.thread;
  // A small stateful store rather than a fixed return value: replaceIdeas both writes
  // and reads back within the same transaction, so a valid completion's result must
  // reflect what was actually inserted, not the seeded "previous" batch.
  let rows: Array<{
    id: string;
    botId: string;
    text: string;
    area: string;
    createdAt: Date;
  }> = (options.previousIdeas ?? [previousIdeaRow]).map((row) => ({ ...row, botId: "bot-1" }));
  let nextId = 0;
  const ideaTable = {
    findMany: vi.fn(async () =>
      [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
    ),
    deleteMany: vi.fn(async ({ where }: { where: { botId: string } }) => {
      const before = rows.length;
      rows = rows.filter((row) => row.botId !== where.botId);
      return { count: before - rows.length };
    }),
    createMany: vi.fn(
      async ({
        data,
      }: {
        data: Array<{
          spaceId: string;
          userId: string;
          botId: string;
          text: string;
          area: string;
          createdAt: Date;
        }>;
      }) => {
        for (const entry of data) {
          rows.push({
            id: `idea-new-${++nextId}`,
            botId: entry.botId,
            text: entry.text,
            area: entry.area,
            createdAt: entry.createdAt,
          });
        }
        return { count: data.length };
      },
    ),
  };
  const prisma = {
    bot: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: "bot-1",
        spaceId: "space-1",
        userId: "user-1",
        thread,
      })),
    },
    goal: {
      findMany: vi.fn(async () => options.goals ?? []),
    },
    message: {
      findMany: vi.fn(async () => options.messages ?? []),
    },
    deploymentSettings: {
      findUnique: vi.fn(async () => options.settings ?? null),
    },
    idea: ideaTable,
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) =>
      callback({ idea: ideaTable }),
    ),
  };
  const runtime = {
    describe: () => ({
      id: "test-runtime",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: {
        streaming: true,
        compaction: options.runtimeCapableOfCompaction ?? true,
        tools: false,
        scripted: false,
      },
    }),
    run: vi.fn<AgentRuntime["run"]>(async function* () {
      yield { type: "done", text: options.completion ?? defaultCompletion() };
    }),
  };
  const memory = {
    describe: () => ({
      id: "test-memory",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { read: true, search: true, commit: true, portable: true },
    }),
    read: vi.fn(async () => ({ documents: options.memoryDocuments ?? [] })),
    search: vi.fn(async () => []),
    commit: vi.fn(),
    exportMarkdown: vi.fn(),
    importMarkdown: vi.fn(),
  };
  const deps = {
    prisma: prisma as unknown as PrismaClient,
    runtime: runtime as unknown as AgentRuntime,
    memory: memory as unknown as MemoryStore,
    deploymentModelKey: options.deploymentModelKey,
    ...(options.resolveModel ? { resolveModel: options.resolveModel } : {}),
  };
  return { prisma, runtime, memory, deps, ideaTable };
}

function defaultCompletion(): string {
  return JSON.stringify(
    Array.from({ length: IDEAS_COUNT }, (_, index) => ({
      text: `Idea number ${index + 1}`,
      area: "work",
    })),
  );
}

describe("parseIdeasCompletion", () => {
  it("parses a plain JSON array", () => {
    const drafts = parseIdeasCompletion('[{"text":"Do a thing","area":"work"}]');
    expect(drafts).toEqual([{ text: "Do a thing", area: "work" }]);
  });

  it("extracts a JSON array from surrounding prose or a markdown fence", () => {
    const drafts = parseIdeasCompletion(
      'Here you go:\n```json\n[{"text":"Do a thing","area":"work"}]\n```',
    );
    expect(drafts).toEqual([{ text: "Do a thing", area: "work" }]);
  });

  it("normalizes a multi-word area down to its first word, lowercased", () => {
    const drafts = parseIdeasCompletion('[{"text":"Do a thing","area":"Home Life"}]');
    expect(drafts?.[0]?.area).toBe("home");
  });

  it("caps at IDEAS_COUNT when the model returns more", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ text: `Idea ${i}`, area: "work" }));
    const drafts = parseIdeasCompletion(JSON.stringify(many));
    expect(drafts).toHaveLength(IDEAS_COUNT);
  });

  it("returns null for unparsable text", () => {
    expect(parseIdeasCompletion("not json at all")).toBeNull();
  });

  it("returns null when items are missing required fields", () => {
    expect(parseIdeasCompletion('[{"text":"Do a thing"}]')).toBeNull();
  });

  it("returns null for an empty array", () => {
    expect(parseIdeasCompletion("[]")).toBeNull();
  });

  it("keeps a valid illustration key", () => {
    const drafts = parseIdeasCompletion(
      '[{"text":"Do a thing","area":"work","illustration":"trophy"}]',
    );
    expect(drafts?.[0]?.illustration).toBe("trophy");
  });

  it("drops an illustration key outside the bundled set", () => {
    const drafts = parseIdeasCompletion(
      '[{"text":"Do a thing","area":"work","illustration":"not-a-real-key"}]',
    );
    expect(drafts?.[0]?.illustration).toBeUndefined();
  });

  it("keeps a short detail as-is", () => {
    const drafts = parseIdeasCompletion(
      '[{"text":"Do a thing","area":"work","detail":"I will do the thing."}]',
    );
    expect(drafts?.[0]?.detail).toBe("I will do the thing.");
  });

  it("caps an over-length detail rather than rejecting the idea", () => {
    const longDetail = "x".repeat(500);
    const drafts = parseIdeasCompletion(
      JSON.stringify([{ text: "Do a thing", area: "work", detail: longDetail }]),
    );
    expect(drafts?.[0]?.detail).toHaveLength(320);
  });

  it("omits detail and illustration when absent", () => {
    const drafts = parseIdeasCompletion('[{"text":"Do a thing","area":"work"}]');
    expect(drafts?.[0]).not.toHaveProperty("detail");
    expect(drafts?.[0]).not.toHaveProperty("illustration");
  });
});

describe("refreshIdeas", () => {
  it("replaces the Muse's ideas wholesale on a valid completion", async () => {
    const harness = ideasHarness({ deploymentModelKey: "openrouter-key" });

    const result = await refreshIdeas(harness.deps, "bot-1");

    expect(harness.ideaTable.deleteMany).toHaveBeenCalledWith({ where: { botId: "bot-1" } });
    expect(harness.ideaTable.createMany).toHaveBeenCalledTimes(1);
    const created = harness.ideaTable.createMany.mock.calls[0]![0] as { data: unknown[] };
    expect(created.data).toHaveLength(IDEAS_COUNT);
    expect(result).toHaveLength(IDEAS_COUNT);
    expect(result.map((idea) => idea.text)).toEqual(
      Array.from({ length: IDEAS_COUNT }, (_, index) => `Idea number ${index + 1}`),
    );
    expect(result.every((idea) => idea.area === "work")).toBe(true);
    expect(result.some((idea) => idea.id === "idea-old")).toBe(false);
  });

  it("keeps the previous ideas when the completion is not valid JSON", async () => {
    const harness = ideasHarness({
      deploymentModelKey: "openrouter-key",
      completion: "sorry, I can't help with that",
    });

    const result = await refreshIdeas(harness.deps, "bot-1");

    expect(harness.ideaTable.deleteMany).not.toHaveBeenCalled();
    expect(harness.ideaTable.createMany).not.toHaveBeenCalled();
    expect(result).toEqual([
      {
        id: "idea-old",
        text: "Old suggestion",
        area: "misc",
        createdAt: "2026-09-01T00:00:00.000Z",
      },
    ]);
  });

  it("keeps the previous ideas when the completion fails schema validation", async () => {
    const harness = ideasHarness({
      deploymentModelKey: "openrouter-key",
      completion: '[{"text":""}]',
    });

    const result = await refreshIdeas(harness.deps, "bot-1");

    expect(harness.ideaTable.createMany).not.toHaveBeenCalled();
    expect(result[0]?.id).toBe("idea-old");
  });

  it("keeps the previous ideas when the runtime reports a failure", async () => {
    const harness = ideasHarness({
      deploymentModelKey: "openrouter-key",
      completion: "I hit a problem: model unavailable",
    });

    const result = await refreshIdeas(harness.deps, "bot-1");

    expect(harness.ideaTable.createMany).not.toHaveBeenCalled();
    expect(result[0]?.id).toBe("idea-old");
  });

  it("skips the model call and keeps previous ideas when no model is configured", async () => {
    const harness = ideasHarness({ settings: null });

    const result = await refreshIdeas(harness.deps, "bot-1");

    expect(harness.runtime.run).not.toHaveBeenCalled();
    expect(harness.ideaTable.createMany).not.toHaveBeenCalled();
    expect(result[0]?.id).toBe("idea-old");
  });

  it("skips the model call when the runtime cannot run one-shot completions", async () => {
    const harness = ideasHarness({
      deploymentModelKey: "openrouter-key",
      runtimeCapableOfCompaction: false,
    });

    await refreshIdeas(harness.deps, "bot-1");

    expect(harness.runtime.run).not.toHaveBeenCalled();
  });

  it("uses resolveModel over the deployment fallback when given", async () => {
    const resolveModel = vi.fn(async () => ({ provider: "anthropic", id: "claude-x" }));
    const harness = ideasHarness({ deploymentModelKey: "openrouter-key", resolveModel });

    await refreshIdeas(harness.deps, "bot-1");

    expect(resolveModel).toHaveBeenCalledWith({
      userId: "user-1",
      spaceId: "space-1",
      botId: "bot-1",
    });
    const [request] = harness.runtime.run.mock.calls[0]!;
    expect(request.model).toEqual({ provider: "anthropic", id: "claude-x" });
  });

  it("asks for exactly IDEAS_COUNT short JSON ideas", async () => {
    const harness = ideasHarness({ deploymentModelKey: "openrouter-key" });

    await refreshIdeas(harness.deps, "bot-1");

    const [request] = harness.runtime.run.mock.calls[0]!;
    expect(request.instructions).toContain(`exactly ${IDEAS_COUNT} objects`);
    expect(request.instructions).toContain("JSON only");
  });

  it("lists the bundled illustration keys and the detail/illustration shape in the prompt", async () => {
    const harness = ideasHarness({ deploymentModelKey: "openrouter-key" });

    await refreshIdeas(harness.deps, "bot-1");

    const [request] = harness.runtime.run.mock.calls[0]!;
    expect(request.instructions).toContain("trophy");
    expect(request.instructions).toContain("detail");
    expect(request.instructions).toContain("illustration");
  });

  it("includes the Conversation's compacted summary and recent messages as prompt data", async () => {
    const harness = ideasHarness({
      deploymentModelKey: "openrouter-key",
      thread: { id: "thread-1", historyCompactionSummary: "Planning a Kyoto trip." },
      messages: [
        { seq: 0, role: "user", blocks: [{ kind: "text", text: "Help me plan Kyoto" }] },
        { seq: 1, role: "bot", blocks: [{ kind: "text", text: "Sure, when are you going?" }] },
      ],
    });

    await refreshIdeas(harness.deps, "bot-1");

    const [request] = harness.runtime.run.mock.calls[0]!;
    expect(request.prompt).toContain("<conversation_summary>");
    expect(request.prompt).toContain("Planning a Kyoto trip.");
    expect(request.prompt).toContain("<recent_conversation>");
    expect(request.prompt).toContain("Help me plan Kyoto");
  });

  it("falls back to a placeholder prompt when there is no context at all", async () => {
    const harness = ideasHarness({
      deploymentModelKey: "openrouter-key",
      thread: null,
      messages: [],
    });

    await refreshIdeas(harness.deps, "bot-1");

    const [request] = harness.runtime.run.mock.calls[0]!;
    expect(request.prompt).toContain("no Goals, memory, or Conversation yet");
  });
});
