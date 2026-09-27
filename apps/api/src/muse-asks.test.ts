import { runContinueJob } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { answerAsk, countAsks, listAsks } from "./muse-asks.js";

const actor: Actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@rakazo.test",
  isDeploymentOwner: true,
};

const BOT_ID = "bot-1";
const CONVERSATION_THREAD_ID = "conv-thread";
const GOAL_LOG_THREAD_ID = "goal-log-1";

// createdAt values keep candidate rows in the same newest-first order the real
// `ORDER BY "createdAt" DESC` query would return them in.
const t = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000);

const CANDIDATE_ROWS = [
  {
    id: "msg-answered",
    threadId: CONVERSATION_THREAD_ID,
    runId: "run-5",
    createdAt: t(0),
    blocks: [{ kind: "ask", text: "Old ask", status: "answered", answer: "ok" }],
  },
  {
    id: "msg-question-conv",
    threadId: CONVERSATION_THREAD_ID,
    runId: "run-4",
    createdAt: t(1),
    blocks: [{ kind: "ask", text: "What's your name?", input: "text" }],
  },
  {
    id: "msg-blocked",
    threadId: GOAL_LOG_THREAD_ID,
    runId: "run-3",
    createdAt: t(2),
    blocks: [{ kind: "ask", text: "Which evenings work for trial lessons?", input: "text" }],
  },
  {
    id: "msg-proposal",
    threadId: GOAL_LOG_THREAD_ID,
    runId: "run-2",
    createdAt: t(3),
    blocks: [
      {
        kind: "ask",
        text: "Add a Saturday conversation club to the plan?",
        actions: [
          { id: "accept", label: "Accept" },
          { id: "dismiss", label: "Dismiss" },
        ],
      },
    ],
  },
  {
    id: "msg-approval",
    threadId: CONVERSATION_THREAD_ID,
    runId: "run-1",
    createdAt: t(4),
    blocks: [
      {
        kind: "ask",
        text: "Review before sending an email to the running club organizer",
        approvalEffectId: "effect-1",
        actions: [
          { id: "allow", label: "Send" },
          { id: "deny", label: "Don't send" },
        ],
      },
    ],
  },
];

function fakePrisma(options: { botRow?: unknown } = {}) {
  const botFindFirst = vi.fn().mockResolvedValue(
    "botRow" in options
      ? options.botRow
      : {
          id: BOT_ID,
          thread: { id: CONVERSATION_THREAD_ID },
          computer: null,
        },
  );
  const goalFindMany = vi.fn().mockResolvedValue([
    {
      id: "goal-1",
      title: "Conversational Japanese before Kyoto",
      log: { id: GOAL_LOG_THREAD_ID },
    },
    { id: "goal-2", title: "Run a half marathon in spring", log: null },
  ]);
  const messageFindMany = vi.fn().mockResolvedValue(CANDIDATE_ROWS);
  const goalProposalFindMany = vi
    .fn()
    .mockResolvedValue([{ goalId: "goal-1", askMessageId: "msg-proposal" }]);
  const prisma = {
    bot: { findFirst: botFindFirst },
    goal: { findMany: goalFindMany },
    message: { findMany: messageFindMany },
    goalProposal: { findMany: goalProposalFindMany },
  } as unknown as PrismaClient;
  return { prisma, botFindFirst, goalFindMany, messageFindMany, goalProposalFindMany };
}

describe("listAsks", () => {
  it("authorizes like other bot-scoped routes", async () => {
    const { prisma, botFindFirst } = fakePrisma({ botRow: null });

    await expect(listAsks(prisma, actor, BOT_ID)).rejects.toThrow();
    expect(botFindFirst).toHaveBeenCalledWith({
      where: { id: BOT_ID, spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
      include: { thread: true, computer: true },
    });
  });

  it("scopes the message query to the Conversation and every Goal-log thread", async () => {
    const { prisma, messageFindMany } = fakePrisma();

    await listAsks(prisma, actor, BOT_ID);

    expect(messageFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          threadId: { in: [CONVERSATION_THREAD_ID, GOAL_LOG_THREAD_ID] },
          role: "bot",
          runId: { not: null },
        }),
      }),
    );
  });

  it("excludes an already-answered ask and maps kinds in priority order (approval > proposal > blocked_task > question)", async () => {
    const { prisma } = fakePrisma();

    const asks = await listAsks(prisma, actor, BOT_ID);

    expect(asks.map((ask) => ask.id)).toEqual([
      "msg-question-conv",
      "msg-blocked",
      "msg-proposal",
      "msg-approval",
    ]);
    expect(asks.find((ask) => ask.id === "msg-approval")).toMatchObject({
      kind: "approval",
      goalId: null,
      goalTitle: null,
      choices: [
        { id: "allow", label: "Send" },
        { id: "deny", label: "Don't send" },
      ],
    });
    expect(asks.find((ask) => ask.id === "msg-proposal")).toMatchObject({
      kind: "proposal",
      goalId: "goal-1",
      goalTitle: "Conversational Japanese before Kyoto",
    });
    expect(asks.find((ask) => ask.id === "msg-blocked")).toMatchObject({
      kind: "blocked_task",
      goalId: "goal-1",
      goalTitle: "Conversational Japanese before Kyoto",
      input: "text",
    });
    // A free-text ask in the Conversation (not a Goal log) never becomes blocked_task.
    expect(asks.find((ask) => ask.id === "msg-question-conv")).toMatchObject({
      kind: "question",
      goalId: null,
      input: "text",
    });
  });
});

describe("countAsks", () => {
  it("matches the length of listAsks for the same filter", async () => {
    const { prisma } = fakePrisma();

    const [asks, counted] = await Promise.all([
      listAsks(prisma, actor, BOT_ID),
      countAsks(prisma, actor, BOT_ID),
    ]);

    expect(counted).toEqual({ count: asks.length });
    expect(counted.count).toBe(4);
  });
});

describe("answerAsk", () => {
  function fakeAnswerDeps(options: { answered?: boolean; targetBotRow?: unknown } = {}) {
    const message = {
      id: "msg-blocked",
      threadId: GOAL_LOG_THREAD_ID,
      thread: { botId: null, goal: { botId: BOT_ID } },
    };
    const messageFindFirst = vi.fn().mockResolvedValue(message);
    const botFindFirst = vi
      .fn()
      .mockResolvedValue(
        "targetBotRow" in options
          ? options.targetBotRow
          : { id: BOT_ID, thread: { id: CONVERSATION_THREAD_ID }, computer: null },
      );
    const prisma = {
      message: { findFirst: messageFindFirst },
      bot: { findFirst: botFindFirst },
    } as unknown as PrismaClient;
    const answerRunInput = vi.fn().mockResolvedValue(options.answered ?? true);
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const deps = { prisma, events: { answerRunInput }, jobs: { enqueue } } as unknown as Parameters<
      typeof answerAsk
    >[0];
    return { deps, messageFindFirst, botFindFirst, answerRunInput, enqueue };
  }

  it("routes the answer to the message's own thread (a Goal log here) via answerRunInput, then wakes the run", async () => {
    const { deps, answerRunInput, enqueue } = fakeAnswerDeps();

    const result = await answerAsk(deps, actor, {
      askId: "msg-blocked",
      runId: "run-3",
      answer: "mon-wed",
    });

    expect(result).toEqual({ ok: true });
    expect(answerRunInput).toHaveBeenCalledWith({
      spaceId: actor.spaceId,
      threadId: GOAL_LOG_THREAD_ID,
      runId: "run-3",
      messageId: "msg-blocked",
      answeredByUserId: actor.userId,
      answer: "mon-wed",
    });
    expect(enqueue).toHaveBeenCalledWith(runContinueJob("run-3"));
  });

  it("rejects answering a Goal whose bot isn't the actor's own", async () => {
    const { deps } = fakeAnswerDeps({ targetBotRow: null });

    await expect(
      answerAsk(deps, actor, { askId: "msg-blocked", runId: "run-3", answer: "mon-wed" }),
    ).rejects.toThrow();
  });

  it("surfaces a stale ask as a conflict instead of silently succeeding", async () => {
    const { deps } = fakeAnswerDeps({ answered: false });

    await expect(
      answerAsk(deps, actor, { askId: "msg-blocked", runId: "run-3", answer: "mon-wed" }),
    ).rejects.toThrow(/no longer awaiting/);
  });
});
