import { runContinueJob } from "@nova/adapter-kit";
import type * as NovaAdaptersModule from "@nova/adapters";
import type { Actor } from "@nova/contracts";
import type { PrismaClient } from "@nova/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mocks only the skill creation so these tests exercise answerAsk's own routing (which apply
// path a given Ask goes through).
vi.mock("@nova/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof NovaAdaptersModule>()),
  skillCreateFromTool: vi.fn(),
}));

import { skillCreateFromTool } from "@nova/adapters";
import { answerAsk, countAsks, listAsks } from "./muse-asks.js";

beforeEach(() => {
  vi.clearAllMocks();
});

const actor: Actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@nova.test",
  isDeploymentOwner: true,
};

const BOT_ID = "bot-1";
const CONVERSATION_THREAD_ID = "conv-thread";

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
    id: "msg-approval",
    threadId: CONVERSATION_THREAD_ID,
    runId: "run-1",
    createdAt: t(2),
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
  const messageFindMany = vi.fn().mockResolvedValue(CANDIDATE_ROWS);
  const prisma = {
    bot: { findFirst: botFindFirst },
    message: { findMany: messageFindMany },
  } as unknown as PrismaClient;
  return { prisma, botFindFirst, messageFindMany };
}

const deps = (prisma: PrismaClient) => ({ prisma });

describe("listAsks", () => {
  it("authorizes like other bot-scoped routes", async () => {
    const { prisma, botFindFirst } = fakePrisma({ botRow: null });

    await expect(listAsks(deps(prisma), undefined, actor, BOT_ID)).rejects.toThrow();
    expect(botFindFirst).toHaveBeenCalledWith({
      where: { id: BOT_ID, spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
      include: { thread: true, computer: true },
    });
  });

  it("scopes the message query to the Conversation", async () => {
    const { prisma, messageFindMany } = fakePrisma();

    await listAsks(deps(prisma), undefined, actor, BOT_ID);

    expect(messageFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          threadId: { in: [CONVERSATION_THREAD_ID] },
          role: "bot",
          runId: { not: null },
        }),
      }),
    );
  });

  it("excludes an already-answered ask and maps approvals and questions", async () => {
    const { prisma } = fakePrisma();

    const asks = await listAsks(deps(prisma), undefined, actor, BOT_ID);

    expect(asks.map((ask) => ask.id)).toEqual(["msg-question-conv", "msg-approval"]);
    expect(asks.find((ask) => ask.id === "msg-approval")).toMatchObject({
      kind: "approval",
      goalId: null,
      goalTitle: null,
      choices: [
        { id: "allow", label: "Send" },
        { id: "deny", label: "Don't send" },
      ],
    });
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
      listAsks(deps(prisma), undefined, actor, BOT_ID),
      countAsks(deps(prisma), undefined, actor, BOT_ID),
    ]);

    expect(counted).toEqual({ count: asks.length });
    expect(counted.count).toBe(2);
  });
});

const SKILL_CONTENT = "---\nname: weekly-rate-watch\ndescription: Rates update\n---\n\n1. Search.";
const SKILL_OFFER_MESSAGE = {
  id: "msg-skill-offer",
  threadId: CONVERSATION_THREAD_ID,
  botId: BOT_ID,
  blocks: [
    {
      kind: "ask",
      text: 'Save "weekly-rate-watch" as a skill?',
      status: "pending",
      actions: [
        { id: "save", label: "Save skill" },
        { id: "dismiss", label: "Not now" },
      ],
      skillOffer: {
        name: "weekly-rate-watch",
        description: "Rates update",
        content: SKILL_CONTENT,
      },
    },
  ],
  thread: { botId: BOT_ID },
};

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
  thread: { botId: BOT_ID },
};

describe("answerAsk", () => {
  function fakeAnswerDeps(
    options: {
      message?: unknown;
      answered?: boolean;
      targetBotRow?: unknown;
      /** No such message in the Conversation (an engine Goal Ask). */
      noMessage?: boolean;
    } = {},
  ) {
    const message = options.noMessage ? null : (options.message ?? APPROVAL_MESSAGE);
    const messageFindFirst = vi.fn().mockResolvedValue(message);
    const botFindFirst = vi
      .fn()
      .mockResolvedValue(
        "targetBotRow" in options
          ? options.targetBotRow
          : { id: BOT_ID, thread: { id: CONVERSATION_THREAD_ID }, computer: null },
      );
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
      messageUpdate,
    };
  }

  it("routes an approval/question Ask through answerRunInput, then wakes the run", async () => {
    const { deps, answerRunInput, enqueue } = fakeAnswerDeps();

    const result = await answerAsk(deps, undefined, actor, {
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
      answerAsk(deps, undefined, actor, {
        askId: APPROVAL_MESSAGE.id,
        runId: "run-1",
        answer: "allow",
      }),
    ).rejects.toThrow();
  });

  it("surfaces a stale ask as a conflict instead of silently succeeding", async () => {
    const { deps } = fakeAnswerDeps({ answered: false });

    await expect(
      answerAsk(deps, undefined, actor, {
        askId: APPROVAL_MESSAGE.id,
        runId: "run-1",
        answer: "allow",
      }),
    ).rejects.toThrow(/no longer awaiting/);
  });

  it("answers an engine ask on the engine, never through a Conversation message", async () => {
    const { deps: answerDeps, answerRunInput } = fakeAnswerDeps({ noMessage: true });
    const prisma = answerDeps.prisma as unknown as { user: unknown };
    prisma.user = { findUnique: vi.fn().mockResolvedValue({ email: "p@example.test" }) };
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${url.pathname} ${String(init?.body)}`);
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        });
      }),
    );
    try {
      const client = { baseUrl: "http://engine.test", proxySecret: "p", secrets: [], tenant: "s" };
      const result = await answerAsk(answerDeps, client, actor, {
        askId: "proposal:obj-1:prop-1",
        runId: "obj-1",
        answer: "accept",
      });
      expect(result).toEqual({ ok: true });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(calls).toEqual([
      'POST /v1/me/asks/proposal%3Aobj-1%3Aprop-1/answer {"choice":"accept"}',
    ]);
    expect(answerRunInput).not.toHaveBeenCalled();
    expect(answerDeps.prisma.message.findFirst).not.toHaveBeenCalled();
  });

  it("rejects an Ask that is neither a Conversation message nor a Goal Ask", async () => {
    const { deps: answerDeps } = fakeAnswerDeps({ noMessage: true });
    await expect(
      answerAsk(answerDeps, undefined, actor, { askId: "nope", runId: "run-1", answer: "x" }),
    ).rejects.toThrow();
  });

  it("saves a skill offer as an agent skill and closes the Ask, without resuming a run", async () => {
    vi.mocked(skillCreateFromTool).mockResolvedValue({ ok: true, id: "skill-1" });
    const { deps, answerRunInput, messageUpdate, notify } = fakeAnswerDeps({
      message: SKILL_OFFER_MESSAGE,
    });

    await answerAsk(deps, undefined, actor, {
      askId: SKILL_OFFER_MESSAGE.id,
      runId: "run-1",
      answer: "save",
    });

    expect(skillCreateFromTool).toHaveBeenCalledWith(
      deps.prisma,
      { spaceId: actor.spaceId, userId: actor.userId },
      { content: SKILL_CONTENT },
    );
    expect(messageUpdate).toHaveBeenCalledWith({
      where: { id: SKILL_OFFER_MESSAGE.id },
      data: {
        blocks: [expect.objectContaining({ kind: "ask", status: "answered", answer: "Saved" })],
      },
    });
    expect(notify).toHaveBeenCalled();
    expect(answerRunInput).not.toHaveBeenCalled();
  });

  it("declines a skill offer without saving anything", async () => {
    const { deps, messageUpdate } = fakeAnswerDeps({ message: SKILL_OFFER_MESSAGE });

    await answerAsk(deps, undefined, actor, {
      askId: SKILL_OFFER_MESSAGE.id,
      runId: "run-1",
      answer: "dismiss",
    });

    expect(skillCreateFromTool).not.toHaveBeenCalled();
    expect(messageUpdate).toHaveBeenCalledWith({
      where: { id: SKILL_OFFER_MESSAGE.id },
      data: { blocks: [expect.objectContaining({ status: "answered", answer: "Not now" })] },
    });
  });
});
