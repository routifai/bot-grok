import { type JobPublisher, runContinueJob } from "@aiden/adapter-kit";
import { acceptGoalProposal, dismissGoalProposal, skillCreateFromTool } from "@aiden/adapters";
import {
  type Actor,
  type Ask,
  type AskKind,
  type MessageBlock,
  MessageBlock as MessageBlockSchema,
} from "@aiden/contracts";
import {
  appendEventInTransaction,
  createRepos,
  IsolationError,
  type PrismaClient,
  type ThreadEvents,
} from "@aiden/db";
import { getLogger } from "@aiden/logging";
import { ORPCError } from "@orpc/server";

// B9 · Asks list (docs/muse/PLAN.md, decision 5). An Ask is a view over a pending
// "ask" or unanswered "choice" message block; the block itself stays the one source
// of truth (CONTEXT.md "Ask"). This module only reads/routes.
//
// Answering (B6): most Asks (approval, question) keep going through the same commit
// path as `threads.answer` (packages/db/src/events.ts answerRunInput), which requires
// a paused run. A Proposal Ask or a blocked-Task Ask (both posted by the `goals` tool,
// goal-tools.ts, straight into the Conversation — never pausing a run for them) can't
// go through that path, so `answerAsk` below applies their effect directly instead:
// a Proposal through `acceptGoalProposal`/`dismissGoalProposal` (the one apply path,
// shared with the `goals.acceptProposal`/`dismissProposal` RPCs in apps/api/src/goals.ts),
// a blocked Task by updating the `GoalTask` itself.

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
 * Kind mapping rule (docs/muse/PLAN.md B9, B6):
 * 1. `approval` — the block carries an `approvalEffectId`.
 * 2. `proposal` — the message is the open `GoalProposal.askMessageId` for its Goal.
 * 3. `blocked_task` — the block carries `goalTaskId`, the explicit marker `goal-tools.ts`
 *    (`update_task`) sets on a blocked Task's Ask (B6 dropped the earlier heuristic — a
 *    free-text ask in a Goal-log thread — because these Asks actually post to the
 *    Conversation, not the Goal log).
 * 4. `question` — everything else (a standalone question, or a Goal-log ask offering
 *    choices rather than free text).
 */
function classifyAskKind(params: { block: AskBlock | ChoiceBlock; isProposal: boolean }): AskKind {
  const { block, isProposal } = params;
  if (block.kind === "ask" && block.approvalEffectId) return "approval";
  if (isProposal) return "proposal";
  if (block.kind === "ask" && block.goalTaskId) return "blocked_task";
  if (block.kind === "ask" && block.skillOffer) return "skill_offer";
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

/** `GoalTask.id` -> its Goal, for every blocked-Task Ask found (the block's `goalTaskId`). */
async function loadGoalIdByTaskId(
  prisma: PrismaClient,
  taskIds: string[],
): Promise<Map<string, string>> {
  if (taskIds.length === 0) return new Map();
  const tasks = await prisma.goalTask.findMany({
    where: { id: { in: taskIds } },
    select: { id: true, goalId: true },
  });
  return new Map(tasks.map((task) => [task.id, task.goalId]));
}

/** Shared by `asks.list` and `asks.count`: same filter, same mapping. */
async function loadAsks(prisma: PrismaClient, actor: Actor, botId: string): Promise<Ask[]> {
  const scope = await loadAskScope(prisma, actor, botId);
  if (scope.threadIds.length === 0) return [];
  const [rows, proposalGoalIdByAskMessageId] = await Promise.all([
    queryAskCandidates(prisma, scope.threadIds),
    loadOpenProposalGoalByAskMessageId(prisma, [...scope.goalIdByThreadId.values()]),
  ]);

  const candidates: { row: AskCandidateRow; runId: string; block: AskBlock | ChoiceBlock }[] = [];
  const blockedTaskIds = new Set<string>();
  for (const row of rows) {
    if (!row.runId) continue;
    const parsed = MessageBlockSchema.array().safeParse(row.blocks);
    if (!parsed.success) continue;
    const block = pendingAskBlock(parsed.data);
    if (!block) continue;
    candidates.push({ row, runId: row.runId, block });
    if (block.kind === "ask" && block.goalTaskId) blockedTaskIds.add(block.goalTaskId);
  }
  const goalIdByTaskId = await loadGoalIdByTaskId(prisma, [...blockedTaskIds]);

  const asks: Ask[] = [];
  for (const { row, runId, block } of candidates) {
    const goalIdFromThread = scope.goalIdByThreadId.get(row.threadId) ?? null;
    const proposalGoalId = proposalGoalIdByAskMessageId.get(row.id) ?? null;
    const blockedTaskGoalId =
      block.kind === "ask" && block.goalTaskId
        ? (goalIdByTaskId.get(block.goalTaskId) ?? null)
        : null;
    const kind = classifyAskKind({ block, isProposal: proposalGoalId != null });
    const goalId = proposalGoalId ?? blockedTaskGoalId ?? goalIdFromThread;
    const goalTitle = goalId ? (scope.goalTitleById.get(goalId) ?? null) : null;

    asks.push({
      id: row.id,
      runId,
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
 * Answers a blocked-Task Ask (marked by the block's `goalTaskId`, goal-tools.ts
 * `update_task`): records the person's answer on the Task's note and sets it back to
 * `pending` so the Muse picks it up again, then marks the Ask's own block answered —
 * the same "flip the one block" shape as `markProposalAskAnswered` in
 * goal-proposals.ts, just not tied to a Proposal.
 */
async function answerBlockedTaskAsk(
  deps: AnswerAskDeps,
  actor: Actor,
  message: { id: string; threadId: string },
  botId: string,
  taskId: string,
  answer: string,
): Promise<void> {
  const notify = await deps.prisma.$transaction(async (tx) => {
    const task = await tx.goalTask.findUnique({ where: { id: taskId } });
    if (!task) return null;
    const note = task.note ? `${task.note}\n\nAnswer: ${answer}` : `Answer: ${answer}`;
    await tx.goalTask.update({ where: { id: task.id }, data: { status: "pending", note } });

    const row = await tx.message.findUnique({ where: { id: message.id } });
    const parsed = MessageBlockSchema.array().safeParse(row?.blocks);
    if (!row || !parsed.success) return null;
    let changed = false;
    const blocks = parsed.data.map((block) => {
      if (block.kind === "ask" && block.goalTaskId === taskId && block.status !== "answered") {
        changed = true;
        return { ...block, status: "answered" as const, answer };
      }
      return block;
    });
    if (!changed) return null;
    await tx.message.update({ where: { id: message.id }, data: { blocks } });
    const event = await appendEventInTransaction(tx, {
      spaceId: actor.spaceId,
      threadId: message.threadId,
      botId,
      type: "thread.message.updated",
      payload: { messageId: message.id, role: "bot", blocks },
    });
    // TODO(B8, docs/muse/PLAN.md "wake on answer"): enqueue `goal.advance {goalId:
    // task.goalId}` here once the job handler lands (packages/adapters/src/
    // background-job-handlers.ts) so the Muse resumes this Goal immediately instead
    // of waiting for the next proactivity tick.
    return { threadId: event.threadId, seq: event.seq };
  });
  if (notify) await deps.events.notify(notify.threadId, notify.seq).catch(() => undefined);
}

/**
 * A skill offer (`offer_skill`): "save" creates the agent skill from the offered SKILL.md,
 * anything else declines. Either way the Ask is marked answered; there is no run to resume.
 */
async function answerSkillOffer(
  deps: AnswerAskDeps,
  actor: Actor,
  message: { id: string; threadId: string },
  botId: string,
  answer: string,
): Promise<void> {
  const row = await deps.prisma.message.findUnique({ where: { id: message.id } });
  const parsed = MessageBlockSchema.array().safeParse(row?.blocks);
  const offer = parsed.success
    ? parsed.data.find(
        (block) => block.kind === "ask" && block.skillOffer && block.status !== "answered",
      )
    : undefined;
  if (!parsed.success || offer?.kind !== "ask" || !offer.skillOffer) {
    throw new ORPCError("CONFLICT", { message: "This offer was already answered" });
  }
  const save = answer === "save";
  if (save) {
    const created = await skillCreateFromTool(
      deps.prisma,
      { spaceId: actor.spaceId, userId: actor.userId },
      { content: offer.skillOffer.content },
    );
    if ("error" in created && !/already exists/.test(String(created.error))) {
      throw new ORPCError("BAD_REQUEST", { message: String(created.error) });
    }
  }
  const blocks = parsed.data.map((block) =>
    block === offer
      ? { ...block, status: "answered" as const, answer: save ? "Saved" : "Not now" }
      : block,
  );
  const event = await deps.prisma.$transaction(async (tx) => {
    await tx.message.update({ where: { id: message.id }, data: { blocks } });
    return appendEventInTransaction(tx, {
      spaceId: actor.spaceId,
      threadId: message.threadId,
      botId,
      type: "thread.message.updated",
      payload: { messageId: message.id, role: "bot", blocks },
    });
  });
  await deps.events.notify(message.threadId, event.seq).catch(() => undefined);
}

/**
 * Answer an Ask, however its message answers: a Proposal or a blocked Task apply
 * their effect directly (no run to resume); everything else routes to the same
 * commit path `threads.answer` uses (`ThreadEvents.answerRunInput`), whichever thread
 * the ask's message actually lives in — the Conversation or a Goal log. `askId` is
 * the message id (see `Ask.id`).
 */
export async function answerAsk(
  deps: AnswerAskDeps,
  actor: Actor,
  input: { askId: string; runId: string; answer: string; username?: string },
): Promise<{ ok: true }> {
  const message = await deps.prisma.message.findFirst({
    where: { id: input.askId, runId: input.runId, role: "bot" },
    select: {
      id: true,
      threadId: true,
      blocks: true,
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

  const openProposal = await deps.prisma.goalProposal.findFirst({
    where: { askMessageId: message.id, status: "open" },
    select: { id: true },
  });
  if (openProposal) {
    if (input.answer !== "accept" && input.answer !== "dismiss") {
      throw new ORPCError("BAD_REQUEST", { message: "Answer a Proposal accept or dismiss." });
    }
    const decide = input.answer === "accept" ? acceptGoalProposal : dismissGoalProposal;
    // jobs must be forwarded here too (not just prisma/events): an accepted Proposal
    // wakes the Goal's background work and refreshes Ideas (goal-proposals.ts
    // decideGoalProposal), both gated on `deps.jobs` being present.
    const goal = await decide(
      { prisma: deps.prisma, events: deps.events, jobs: deps.jobs },
      openProposal.id,
    );
    if (!goal) {
      throw new ORPCError("CONFLICT", { message: "This proposal is no longer open" });
    }
    return { ok: true as const };
  }

  const parsedBlocks = MessageBlockSchema.array().safeParse(message.blocks);
  const pending = parsedBlocks.success ? pendingAskBlock(parsedBlocks.data) : null;
  if (pending?.kind === "ask" && pending.goalTaskId) {
    await answerBlockedTaskAsk(deps, actor, message, targetBotId, pending.goalTaskId, input.answer);
    return { ok: true as const };
  }
  if (pending?.kind === "ask" && pending.skillOffer) {
    await answerSkillOffer(deps, actor, message, targetBotId, input.answer);
    return { ok: true as const };
  }

  const answered = await deps.events.answerRunInput({
    spaceId: actor.spaceId,
    threadId: message.threadId,
    runId: input.runId,
    messageId: message.id,
    answeredByUserId: actor.userId,
    answer: input.answer,
    username: input.username,
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
