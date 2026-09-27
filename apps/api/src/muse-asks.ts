import { type JobPublisher, runContinueJob } from "@aiden/adapter-kit";
import {
  type Actor,
  type Ask,
  type AskKind,
  type MessageBlock,
  MessageBlock as MessageBlockSchema,
} from "@aiden/contracts";
import { createRepos, IsolationError, type PrismaClient, type ThreadEvents } from "@aiden/db";
import { getLogger } from "@aiden/logging";
import { ORPCError } from "@orpc/server";

// B9 · Asks list (docs/muse/PLAN.md, decision 5). An Ask is a view over a pending
// "ask" or unanswered "choice" message block; the block itself stays the one source
// of truth (CONTEXT.md "Ask"). This module only reads/routes; answering keeps using
// the same commit path as `threads.answer` (packages/db/src/events.ts answerRunInput)
// so there is exactly one place that flips a block from pending to answered.

type AskBlock = Extract<MessageBlock, { kind: "ask" }>;
type ChoiceBlock = Extract<MessageBlock, { kind: "choice" }>;

interface AskScope {
  /** Every thread to scan: the Conversation plus every Goal-log thread. */
  threadIds: string[];
  /** Goal-log threadId -> the Goal it belongs to. */
  goalIdByThreadId: Map<string, string>;
  /** Goal id -> title, for both Goal-log asks and Proposal asks (whichever thread they live in). */
  goalTitleById: Map<string, string>;
}

async function loadAskScope(prisma: PrismaClient, actor: Actor, botId: string): Promise<AskScope> {
  const repos = createRepos(prisma);
  const bot = await repos.getBot(actor, botId);
  const goals = await prisma.goal.findMany({
    where: { botId },
    select: { id: true, title: true, log: { select: { id: true } } },
  });
  const threadIds: string[] = [];
  const goalIdByThreadId = new Map<string, string>();
  const goalTitleById = new Map<string, string>();
  if (bot.thread) threadIds.push(bot.thread.id);
  for (const goal of goals) {
    goalTitleById.set(goal.id, goal.title);
    if (goal.log) {
      threadIds.push(goal.log.id);
      goalIdByThreadId.set(goal.log.id, goal.id);
    }
  }
  return { threadIds, goalIdByThreadId, goalTitleById };
}

interface AskCandidateRow {
  id: string;
  threadId: string;
  runId: string | null;
  blocks: unknown;
  createdAt: Date;
}

/**
 * Candidate bot messages that might hold an open ask: scoped to this Muse's own
 * threads (already indexed on threadId) and narrowed by a Postgres jsonb
 * containment check (`blocks @> '[{"kind":"ask"}]'`, same operator already used by
 * `messages.ts` / `events.ts` for channel_message filtering) so we never pull a
 * thread's ordinary text/progress traffic across the wire. The containment check
 * only matches on `kind`; whether the match is still *pending* (status/answerId)
 * is decided after parsing, in `pendingAskBlock`.
 */
async function queryAskCandidates(
  prisma: PrismaClient,
  threadIds: string[],
): Promise<AskCandidateRow[]> {
  if (threadIds.length === 0) return [];
  return prisma.message.findMany({
    where: {
      threadId: { in: threadIds },
      role: "bot",
      // An ask answerable through asks.answer always names the run it belongs to;
      // a bot message with no run (e.g. a one-off system note) can't be one.
      runId: { not: null },
      OR: [
        { blocks: { array_contains: [{ kind: "ask" }] } },
        { blocks: { array_contains: [{ kind: "choice" }] } },
      ],
    },
    select: { id: true, threadId: true, runId: true, blocks: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
}

/** The one still-open ask/choice block in a message, if any (first match wins, same as
 * `findPendingAsk` in packages/db/src/events.ts — a message holds at most one live ask). */
function pendingAskBlock(blocks: MessageBlock[]): AskBlock | ChoiceBlock | null {
  for (const block of blocks) {
    if (block.kind === "ask" && block.status !== "answered") return block;
    if (block.kind === "choice" && !block.answerId) return block;
  }
  return null;
}

/**
 * Kind mapping rule (docs/muse/PLAN.md B9):
 * 1. `approval` — the block carries an `approvalEffectId`.
 * 2. `proposal` — the message is the open `GoalProposal.askMessageId` for its Goal.
 * 3. `blocked_task` — B4 has not landed a dedicated marker for this yet, so we detect
 *    it structurally: a free-text "ask" block (`input: "text"`) sitting in a Goal-log
 *    thread that isn't an approval or a Proposal. This is a heuristic, not a real
 *    field — once B4 adds a recognisable marker (e.g. a `goalTaskId` on the block),
 *    prefer that and drop this fallback.
 * 4. `question` — everything else (a standalone question, or a Goal-log ask offering
 *    choices rather than free text).
 */
function classifyAskKind(params: {
  block: AskBlock | ChoiceBlock;
  isGoalLogThread: boolean;
  isProposal: boolean;
}): AskKind {
  const { block, isGoalLogThread, isProposal } = params;
  if (block.kind === "ask" && block.approvalEffectId) return "approval";
  if (isProposal) return "proposal";
  if (block.kind === "ask" && isGoalLogThread && block.input === "text") return "blocked_task";
  return "question";
}

function toAskChoices(block: AskBlock | ChoiceBlock): Ask["choices"] {
  if (block.kind === "ask") {
    return (block.actions ?? []).map((action) => ({ id: action.id, label: action.label }));
  }
  return block.options.map((option) => ({ id: option.id, label: option.label }));
}

/** Open `GoalProposal.askMessageId` -> its Goal, for every Goal-log thread in scope. */
async function loadOpenProposalGoalByAskMessageId(
  prisma: PrismaClient,
  goalIds: string[],
): Promise<Map<string, string>> {
  if (goalIds.length === 0) return new Map();
  const proposals = await prisma.goalProposal.findMany({
    where: { goalId: { in: goalIds }, status: "open", askMessageId: { not: null } },
    select: { goalId: true, askMessageId: true },
  });
  const byAskMessageId = new Map<string, string>();
  for (const proposal of proposals) {
    if (proposal.askMessageId) byAskMessageId.set(proposal.askMessageId, proposal.goalId);
  }
  return byAskMessageId;
}

/** Shared by `asks.list` and `asks.count`: same filter, same mapping. */
async function loadAsks(prisma: PrismaClient, actor: Actor, botId: string): Promise<Ask[]> {
  const scope = await loadAskScope(prisma, actor, botId);
  if (scope.threadIds.length === 0) return [];
  const [rows, proposalGoalIdByAskMessageId] = await Promise.all([
    queryAskCandidates(prisma, scope.threadIds),
    loadOpenProposalGoalByAskMessageId(prisma, [...scope.goalIdByThreadId.values()]),
  ]);

  const asks: Ask[] = [];
  for (const row of rows) {
    if (!row.runId) continue;
    const parsed = MessageBlockSchema.array().safeParse(row.blocks);
    if (!parsed.success) continue;
    const block = pendingAskBlock(parsed.data);
    if (!block) continue;

    const goalIdFromThread = scope.goalIdByThreadId.get(row.threadId) ?? null;
    const proposalGoalId = proposalGoalIdByAskMessageId.get(row.id) ?? null;
    const kind = classifyAskKind({
      block,
      isGoalLogThread: goalIdFromThread != null,
      isProposal: proposalGoalId != null,
    });
    const goalId = proposalGoalId ?? goalIdFromThread;
    const goalTitle = goalId ? (scope.goalTitleById.get(goalId) ?? null) : null;

    asks.push({
      id: row.id,
      runId: row.runId,
      kind,
      goalId,
      goalTitle,
      text: block.kind === "ask" ? block.text : block.question,
      detail: block.kind === "ask" ? block.detail : block.subtitle,
      choices: toAskChoices(block),
      input: block.kind === "ask" ? (block.input ?? null) : null,
      createdAt: row.createdAt.toISOString(),
    });
  }
  // `queryAskCandidates` already orders by createdAt desc; rows skipped above (answered,
  // unparsable) don't disturb the order of what's left.
  return asks;
}

export async function listAsks(prisma: PrismaClient, actor: Actor, botId: string): Promise<Ask[]> {
  return loadAsks(prisma, actor, botId);
}

export async function countAsks(
  prisma: PrismaClient,
  actor: Actor,
  botId: string,
): Promise<{ count: number }> {
  // Same filter as listAsks, reused rather than duplicated (asks are few per Muse —
  // at most one open Proposal per Goal plus whatever's currently blocked or waiting
  // on approval — so re-running the same narrow query costs one more JSON parse
  // pass, not another round trip shape).
  const asks = await loadAsks(prisma, actor, botId);
  return { count: asks.length };
}

export interface AnswerAskDeps {
  prisma: PrismaClient;
  events: ThreadEvents;
  jobs: JobPublisher;
}

/**
 * Route an Ask's answer to the same commit path `threads.answer` uses
 * (`ThreadEvents.answerRunInput`), whichever thread the ask's message actually lives
 * in — the Conversation or a Goal log. `askId` is the message id (see `Ask.id`).
 */
export async function answerAsk(
  deps: AnswerAskDeps,
  actor: Actor,
  input: { askId: string; runId: string; answer: string },
): Promise<{ ok: true }> {
  const message = await deps.prisma.message.findFirst({
    where: { id: input.askId, runId: input.runId, role: "bot" },
    select: {
      id: true,
      threadId: true,
      thread: { select: { botId: true, goal: { select: { botId: true } } } },
    },
  });
  if (!message) throw new IsolationError();
  const targetBotId = message.thread.botId ?? message.thread.goal?.botId;
  if (!targetBotId) throw new IsolationError();
  // Authorizes like every other bot-scoped route: throws unless `targetBotId` is
  // one of this actor's own bots in their own Space. Covers both the Conversation
  // (thread.botId) and a Goal log (thread.goal.botId) the same way.
  await createRepos(deps.prisma).getBot(actor, targetBotId);

  const answered = await deps.events.answerRunInput({
    spaceId: actor.spaceId,
    threadId: message.threadId,
    runId: input.runId,
    messageId: message.id,
    answeredByUserId: actor.userId,
    answer: input.answer,
  });
  if (!answered) {
    throw new ORPCError("CONFLICT", { message: "This prompt is no longer awaiting an answer" });
  }
  await deps.jobs.enqueue(runContinueJob(input.runId)).catch((error) => {
    // The answer and queued run are durable; the reconciler repairs a missed immediate wake.
    getLogger().error("ask answer enqueue", error);
  });
  return { ok: true as const };
}
