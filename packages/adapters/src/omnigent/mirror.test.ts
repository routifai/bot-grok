import type { PrismaClient, ThreadEvents } from "@aiden/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OmnigentApiError } from "./client.js";
import { MIRROR_RUN_TRIGGER, reconcileOmnigentMirror } from "./mirror.js";

const { listOmnigentSessionItems } = vi.hoisted(() => ({
  listOmnigentSessionItems: vi.fn(),
}));

// Keep every other export real (isStaleCursorError, OmnigentApiError) — only the network call
// itself is faked.
vi.mock("./client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client.js")>();
  return { ...actual, listOmnigentSessionItems };
});

const CLIENT = { baseUrl: "http://omnigent.test", proxySecret: "secret" };
const SESSION = { botId: "bot-1", omnigentSessionId: "conv_super", lastMirroredItemId: null };
const BOT_ROW = {
  id: "bot-1",
  spaceId: "space-1",
  userId: "user-1",
  thread: { id: "thread-1" },
};

function fakePrisma(overrides: Record<string, unknown> = {}) {
  const base = {
    omnigentSession: {
      findMany: vi.fn(async () => [SESSION]),
      update: vi.fn(async () => ({})),
    },
    bot: { findUnique: vi.fn(async () => BOT_ROW) },
    user: { findUnique: vi.fn(async () => ({ email: "person@example.test" })) },
    task: { create: vi.fn(async () => ({ id: "task-1" })) },
    run: {
      create: vi.fn(async () => ({ id: "run-1" })),
      findFirst: vi.fn(async () => null),
    },
    attempt: { create: vi.fn(async () => ({ id: "attempt-1" })) },
  };
  return { ...base, ...overrides } as unknown as PrismaClient;
}

function fakeEvents(finalizeRun = vi.fn(async () => ({ continuationRunId: null }))) {
  return { finalizeRun } as unknown as ThreadEvents;
}

function assistantItem(id: string, text: string, createdAt = 1000) {
  return {
    id,
    type: "message",
    role: "assistant",
    created_at: createdAt,
    content: [{ type: "output_text", text }],
  };
}

describe("reconcileOmnigentMirror", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("only scans sessions with recent Super Chat activity", async () => {
    const findMany = vi.fn(async () => []);
    const prisma = fakePrisma({ omnigentSession: { findMany, update: vi.fn() } });
    await reconcileOmnigentMirror({
      prisma,
      events: fakeEvents(),
      client: CLIENT,
      secrets: [],
      workerId: "w",
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { updatedAt: { gte: expect.any(Date) } } }),
    );
  });

  it("scans items after the recorded cursor and mirrors a new assistant message", async () => {
    listOmnigentSessionItems.mockResolvedValue({
      data: [assistantItem("item_1", "Here are the Q4 totals.")],
    });
    const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
    const prisma = fakePrisma();
    await reconcileOmnigentMirror({
      prisma,
      events: fakeEvents(finalizeRun),
      client: CLIENT,
      secrets: [],
      workerId: "worker-1",
    });

    expect(listOmnigentSessionItems).toHaveBeenCalledWith(
      CLIENT,
      "person@example.test",
      "conv_super",
      expect.objectContaining({ after: undefined, order: "asc" }),
    );
    expect(prisma.run.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ trigger: MIRROR_RUN_TRIGGER }) }),
    );
    expect(finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "completed",
        blocks: [{ kind: "text", text: "Here are the Q4 totals." }],
        markUnread: true,
      }),
    );
    expect(prisma.omnigentSession.update).toHaveBeenCalledWith({
      where: { botId: "bot-1" },
      data: { lastMirroredItemId: "item_1" },
    });
  });

  it("resumes from the recorded lastMirroredItemId instead of rescanning from the start", async () => {
    listOmnigentSessionItems.mockResolvedValue({ data: [] });
    const prisma = fakePrisma({
      omnigentSession: {
        findMany: vi.fn(async () => [{ ...SESSION, lastMirroredItemId: "item_0" }]),
        update: vi.fn(),
      },
    });
    await reconcileOmnigentMirror({
      prisma,
      events: fakeEvents(),
      client: CLIENT,
      secrets: [],
      workerId: "w",
    });
    expect(listOmnigentSessionItems).toHaveBeenCalledWith(
      CLIENT,
      "person@example.test",
      "conv_super",
      expect.objectContaining({ after: "item_0" }),
    );
  });

  it("advances the cursor past a tool-call item without creating a run", async () => {
    listOmnigentSessionItems.mockResolvedValue({
      data: [{ id: "fc_1", type: "function_call", created_at: 999 }],
    });
    const finalizeRun = vi.fn();
    const prisma = fakePrisma();
    await reconcileOmnigentMirror({
      prisma,
      events: fakeEvents(finalizeRun),
      client: CLIENT,
      secrets: [],
      workerId: "w",
    });
    expect(finalizeRun).not.toHaveBeenCalled();
    expect(prisma.run.create).not.toHaveBeenCalled();
    expect(prisma.omnigentSession.update).toHaveBeenCalledWith({
      where: { botId: "bot-1" },
      data: { lastMirroredItemId: "fc_1" },
    });
  });

  it("never advances the cursor past an item it failed to mirror, so a retry re-processes it", async () => {
    listOmnigentSessionItems.mockResolvedValue({
      data: [assistantItem("item_bad", "This will fail to post.")],
    });
    const finalizeRun = vi.fn(async () => {
      throw new Error("db unavailable");
    });
    const prisma = fakePrisma();
    // One session's failure must not throw out of reconcileOmnigentMirror (it logs and
    // continues to the next session on the next tick).
    await expect(
      reconcileOmnigentMirror({
        prisma,
        events: fakeEvents(finalizeRun),
        client: CLIENT,
        secrets: [],
        workerId: "w",
      }),
    ).resolves.toBeUndefined();
    expect(prisma.omnigentSession.update).not.toHaveBeenCalled();
  });

  it("does not mirror a reply the normal run path already delivered for this turn", async () => {
    // The gateway stamps lastMirroredItemId to the turn's last item id right after finishing
    // (./gateway.ts), so a mirror scan "after" it must never see that item again.
    listOmnigentSessionItems.mockResolvedValue({ data: [] });
    const prisma = fakePrisma({
      omnigentSession: {
        findMany: vi.fn(async () => [{ ...SESSION, lastMirroredItemId: "item_from_normal_turn" }]),
        update: vi.fn(),
      },
    });
    const finalizeRun = vi.fn();
    await reconcileOmnigentMirror({
      prisma,
      events: fakeEvents(finalizeRun),
      client: CLIENT,
      secrets: [],
      workerId: "w",
    });
    expect(finalizeRun).not.toHaveBeenCalled();
  });

  it("skips a Super Chat the engine no longer has, leaving the cursor alone", async () => {
    listOmnigentSessionItems.mockRejectedValue(
      new OmnigentApiError("omnigent list session items failed (404): ", "not_found"),
    );
    const prisma = fakePrisma();
    const finalizeRun = vi.fn();
    await reconcileOmnigentMirror({
      prisma,
      events: fakeEvents(finalizeRun),
      client: CLIENT,
      secrets: [],
      workerId: "w",
    });
    expect(finalizeRun).not.toHaveBeenCalled();
    expect(prisma.omnigentSession.update).not.toHaveBeenCalled();
  });

  it("resets a stale cursor to null and retries from the start next tick", async () => {
    listOmnigentSessionItems.mockRejectedValue(
      new OmnigentApiError("omnigent list session items failed (400): ", "stale_cursor"),
    );
    const prisma = fakePrisma({
      omnigentSession: {
        findMany: vi.fn(async () => [{ ...SESSION, lastMirroredItemId: "item_deleted" }]),
        update: vi.fn(async () => ({})),
      },
    });
    const finalizeRun = vi.fn();
    await expect(
      reconcileOmnigentMirror({
        prisma,
        events: fakeEvents(finalizeRun),
        client: CLIENT,
        secrets: [],
        workerId: "w",
      }),
    ).resolves.toBeUndefined();
    expect(finalizeRun).not.toHaveBeenCalled();
    expect(prisma.omnigentSession.update).toHaveBeenCalledWith({
      where: { botId: "bot-1" },
      data: { lastMirroredItemId: null },
    });
  });

  it("does not reset the cursor on a non-stale-cursor failure (left for the retry path to re-fetch)", async () => {
    listOmnigentSessionItems.mockRejectedValue(new Error("omnigent is down"));
    const prisma = fakePrisma({
      omnigentSession: {
        findMany: vi.fn(async () => [{ ...SESSION, lastMirroredItemId: "item_0" }]),
        update: vi.fn(async () => ({})),
      },
    });
    // A plain network/5xx failure must not be mistaken for a stale cursor: reconcileOmnigentMirror
    // still resolves (one session's failure never blocks the rest) but the cursor is untouched.
    await expect(
      reconcileOmnigentMirror({
        prisma,
        events: fakeEvents(),
        client: CLIENT,
        secrets: [],
        workerId: "w",
      }),
    ).resolves.toBeUndefined();
    expect(prisma.omnigentSession.update).not.toHaveBeenCalled();
  });

  it("skips a bot with no private Conversation thread", async () => {
    const prisma = fakePrisma({
      bot: { findUnique: vi.fn(async () => ({ ...BOT_ROW, thread: null })) },
    });
    await expect(
      reconcileOmnigentMirror({
        prisma,
        events: fakeEvents(),
        client: CLIENT,
        secrets: [],
        workerId: "w",
      }),
    ).resolves.toBeUndefined();
    expect(listOmnigentSessionItems).not.toHaveBeenCalled();
  });
  it("waits while a turn the person started is still running", async () => {
    const prisma = fakePrisma({
      run: {
        create: vi.fn(async () => ({ id: "run-1" })),
        findFirst: vi.fn(async () => ({ id: "run-active" })),
      },
    });
    const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
    await reconcileOmnigentMirror({
      prisma,
      events: fakeEvents(finalizeRun),
      client: CLIENT,
      secrets: [],
      workerId: "worker-1",
    });
    expect(finalizeRun).not.toHaveBeenCalled();
  });
});
