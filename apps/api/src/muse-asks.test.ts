import { runContinueJob } from "@aiden/adapter-kit";
import type * as AidenAdaptersModule from "@aiden/adapters";
import type { Actor } from "@aiden/contracts";
import type { PrismaClient } from "@aiden/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mocks only the one Proposal apply path so these tests exercise answerAsk's own
// routing (which apply path a given Ask goes through), not goal-proposals.ts's
// internals (covered in depth by packages/adapters/src/muse/goal-tools.test.ts).
vi.mock("@aiden/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof AidenAdaptersModule>()),
  acceptGoalProposal: vi.fn(),
  dismissGoalProposal: vi.fn(),
}));

import { acceptGoalProposal, dismissGoalProposal } from "@aiden/adapters";
import { answerAsk, countAsks, listAsks } from "./muse-asks.js";

beforeEach(() => {
  vi.clearAllMocks();
});

const actor: Actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@aiden.test",
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
    // Posted straight into the Conversation by goal-tools.ts `update_task` (B4), not the
    // Goal log — `goalTaskId` is what marks it blocked_task, not which thread it's in.
    id: "msg-blocked",
    threadId: CONVERSATION_THREAD_ID,
    runId: "run-3",
    createdAt: t(2),
    blocks: [
      {
        kind: "ask",
        text: "Which evenings work for trial lessons?",
        input: "text",
        goalTaskId: "task-1",
      },
    ],
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
  const goalTaskFindMany = vi.fn().mockResolvedValue([{ id: "task-1", goalId: "goal-1" }]);
  const prisma = {
    bot: { findFirst: botFindFirst },
    goal: { findMany: goalFindMany },
    message: { findMany: messageFindMany },
    goalProposal: { findMany: goalProposalFindMany },
    goalTask: { findMany: goalTaskFindMany },
  } as unknown as PrismaClient;
  return {
    prisma,
    botFindFirst,
    goalFindMany,
    messageFindMany,
    goalProposalFindMany,
    goalTaskFindMany,
  };
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
    // Its goalId comes from the block's `goalTaskId` -> GoalTask -> Goal, not from
    // living in a Goal-log thread (it's posted to the Conversation, like any Ask).
    expect(asks.find((ask) => ask.id === "msg-blocked")).toMatchObject({
      kind: "blocked_task",
      goalId: "goal-1",
      goalTitle: "Conversational Japanese before Kyoto",
      input: "text",
    });
    // A plain free-text Conversation ask with no `goalTaskId` stays a question.
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

const APPROVAL_MESSAGE = {
  id: "msg-approval-ask",
  threadId: CONVERSATION_THREAD_ID,
  botId: BOT_ID,
  blocks: [
    {
      kind: "ask",
      text: "Review before sending an email to the running club organizer",
      approvalEffectId: "effect-1",
      status: "pending",
      actions: [
        { id: "allow", label: "Send" },
        { id: "deny", label: "Don't send" },
      ],
    },
  ],
  thread: { botId: BOT_ID, goal: null },
};

const BLOCKED_TASK_MESSAGE = {
  id: "msg-blocked",
  threadId: CONVERSATION_THREAD_ID,
  botId: BOT_ID,
  blocks: [
    {
      kind: "ask",
      text: "Which evenings work for trial lessons?",
      input: "text",
      status: "pending",
      goalTaskId: "task-1",
    },
  ],
  thread: { botId: BOT_ID, goal: null },
};

const PROPOSAL_MESSAGE = {
  id: "msg-proposal",
  threadId: CONVERSATION_THREAD_ID,
  botId: BOT_ID,
  blocks: [
    {
      kind: "ask",
      text: 'Accept the plan for "Conversational Japanese before Kyoto"?',
      status: "pending",
      actions: [
        { id: "accept", label: "Accept plan" },
        { id: "dismiss", label: "Keep current" },
      ],
    },
  ],
  thread: { botId: BOT_ID, goal: null },
};

describe("answerAsk", () => {
  function fakeAnswerDeps(
    options: {
      message?: unknown;
      answered?: boolean;
      targetBotRow?: unknown;
      openProposal?: unknown;
      goalTask?: { id: string; goalId: string; note: string };
    } = {},
  ) {
    const message = options.message ?? APPROVAL_MESSAGE;
    const messageFindFirst = vi.fn().mockResolvedValue(message);
    const botFindFirst = vi
      .fn()
      .mockResolvedValue(
        "targetBotRow" in options
          ? options.targetBotRow
          : { id: BOT_ID, thread: { id: CONVERSATION_THREAD_ID }, computer: null },
      );
    const goalProposalFindFirst = vi
      .fn()
      .mockResolvedValue("openProposal" in options ? options.openProposal : null);

    let task = options.goalTask ?? {
      id: "task-1",
      goalId: "goal-1",
      note: "Needs your available evenings.",
    };
    const goalTaskFindUnique = vi.fn().mockImplementation(async () => task);
    const goalTaskUpdate = vi.fn().mockImplementation(async ({ data }: { data: object }) => {
      task = { ...task, ...data };
      return task;
    });

    let storedMessage = message as { blocks: unknown };
    const messageFindUnique = vi.fn().mockImplementation(async () => storedMessage);
    const messageUpdate = vi.fn().mockImplementation(async ({ data }: { data: object }) => {
      storedMessage = { ...storedMessage, ...data };
      return storedMessage;
    });
    const threadUpdate = vi.fn().mockResolvedValue({ nextEventSeq: 1 });
    const eventCreate = vi
      .fn()
      .mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "event-1",
        ...data,
      }));

    const prisma = {
      message: {
        findFirst: messageFindFirst,
        findUnique: messageFindUnique,
        update: messageUpdate,
      },
      bot: { findFirst: botFindFirst },
      goalProposal: { findFirst: goalProposalFindFirst },
      goalTask: { findUnique: goalTaskFindUnique, update: goalTaskUpdate },
      thread: { update: threadUpdate },
      event: { create: eventCreate },
    } as Record<string, unknown>;
    prisma.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma);

    const answerRunInput = vi.fn().mockResolvedValue(options.answered ?? true);
    const notify = vi.fn().mockResolvedValue(undefined);
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const deps = {
      prisma: prisma as unknown as PrismaClient,
      events: { answerRunInput, notify },
      jobs: { enqueue },
    } as unknown as Parameters<typeof answerAsk>[0];
    return {
      deps,
      messageFindFirst,
      botFindFirst,
      answerRunInput,
      enqueue,
      notify,
      goalTaskUpdate,
      messageUpdate,
    };
  }

  it("routes an approval/question Ask through answerRunInput, then wakes the run", async () => {
    const { deps, answerRunInput, enqueue } = fakeAnswerDeps();

    const result = await answerAsk(deps, actor, {
      askId: APPROVAL_MESSAGE.id,
      runId: "run-1",
      answer: "allow",
    });

    expect(result).toEqual({ ok: true });
    expect(answerRunInput).toHaveBeenCalledWith({
      spaceId: actor.spaceId,
      threadId: CONVERSATION_THREAD_ID,
      runId: "run-1",
      messageId: APPROVAL_MESSAGE.id,
      answeredByUserId: actor.userId,
      answer: "allow",
    });
    expect(enqueue).toHaveBeenCalledWith(runContinueJob("run-1"));
  });

  it("rejects answering a Goal whose bot isn't the actor's own", async () => {
    const { deps } = fakeAnswerDeps({ targetBotRow: null });

    await expect(
      answerAsk(deps, actor, { askId: APPROVAL_MESSAGE.id, runId: "run-1", answer: "allow" }),
    ).rejects.toThrow();
  });

  it("surfaces a stale ask as a conflict instead of silently succeeding", async () => {
    const { deps } = fakeAnswerDeps({ answered: false });

    await expect(
      answerAsk(deps, actor, { askId: APPROVAL_MESSAGE.id, runId: "run-1", answer: "allow" }),
    ).rejects.toThrow(/no longer awaiting/);
  });

  it("answers a blocked-Task Ask by updating the Task directly, never touching answerRunInput", async () => {
    const { deps, answerRunInput, enqueue, goalTaskUpdate, messageUpdate, notify } = fakeAnswerDeps(
      { message: BLOCKED_TASK_MESSAGE },
    );

    const result = await answerAsk(deps, actor, {
      askId: "msg-blocked",
      runId: "run-3",
      answer: "Tuesday and Thursday evenings",
    });

    expect(result).toEqual({ ok: true });
    expect(goalTaskUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "task-1" },
        data: expect.objectContaining({
          status: "pending",
          note: expect.stringContaining("Tuesday and Thursday evenings"),
        }),
      }),
    );
    const [updateCall] = messageUpdate.mock.calls;
    expect(updateCall?.[0]?.data?.blocks?.[0]).toMatchObject({
      status: "answered",
      answer: "Tuesday and Thursday evenings",
    });
    expect(notify).toHaveBeenCalled();
    expect(answerRunInput).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("accepts an open Proposal through the shared apply path instead of answerRunInput", async () => {
    const { deps, answerRunInput, enqueue } = fakeAnswerDeps({
      message: PROPOSAL_MESSAGE,
      openProposal: { id: "proposal-1" },
    });
    vi.mocked(acceptGoalProposal).mockResolvedValue({ id: "goal-1" } as never);

    const result = await answerAsk(deps, actor, {
      askId: "msg-proposal",
      runId: "run-2",
      answer: "accept",
    });

    expect(result).toEqual({ ok: true });
    expect(acceptGoalProposal).toHaveBeenCalledWith(
      expect.objectContaining({ prisma: deps.prisma }),
      "proposal-1",
    );
    expect(dismissGoalProposal).not.toHaveBeenCalled();
    expect(answerRunInput).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("dismisses an open Proposal through the same shared apply path", async () => {
    const { deps } = fakeAnswerDeps({
      message: PROPOSAL_MESSAGE,
      openProposal: { id: "proposal-1" },
    });
    vi.mocked(dismissGoalProposal).mockResolvedValue({ id: "goal-1" } as never);

    await answerAsk(deps, actor, { askId: "msg-proposal", runId: "run-2", answer: "dismiss" });

    expect(dismissGoalProposal).toHaveBeenCalledWith(
      expect.objectContaining({ prisma: deps.prisma }),
      "proposal-1",
    );
  });

  it("rejects an answer to a Proposal that isn't accept or dismiss", async () => {
    const { deps } = fakeAnswerDeps({
      message: PROPOSAL_MESSAGE,
      openProposal: { id: "proposal-1" },
    });

    await expect(
      answerAsk(deps, actor, { askId: "msg-proposal", runId: "run-2", answer: "allow" }),
    ).rejects.toThrow();
  });

  it("surfaces an already-decided Proposal as a conflict", async () => {
    const { deps } = fakeAnswerDeps({
      message: PROPOSAL_MESSAGE,
      openProposal: { id: "proposal-1" },
    });
    vi.mocked(acceptGoalProposal).mockResolvedValue(null);

    await expect(
      answerAsk(deps, actor, { askId: "msg-proposal", runId: "run-2", answer: "accept" }),
    ).rejects.toThrow(/no longer open/);
  });
});
