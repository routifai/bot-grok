import { type JobPublisher, runContinueJob } from "@aiden/adapter-kit";
import { type OmnigentClientConfig, skillCreateFromTool } from "@aiden/adapters";
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
import { engineAnswerAsk, engineListAsks, isEngineAskId } from "./engine-asks.js";

// Asks list (docs/muse/PLAN.md, decision 5). On the engine, the Asks are the engine's decisions
// inbox (./engine-asks.ts, ADR 0009). Without it, an Ask is a view over a pending "ask" or
// unanswered "choice" message block in the Conversation; the block itself stays the one source
// of truth (CONTEXT.md "Ask"). This module only reads/routes.
//
// Answering without the engine: most Asks (approval, question) go through the same commit path
// as `threads.answer` (packages/db/src/events.ts answerRunInput), which requires a paused run,
// and a skill offer is applied directly.

type AskBlock = Extract<MessageBlock, { kind: "ask" }>;
type ChoiceBlock = Extract<MessageBlock, { kind: "choice" }>;

/** The Conversation's thread, the only one that holds Asks; none until the Muse has one. */
async function loadAskThreadIds(
  prisma: PrismaClient,
  actor: Actor,
  botId: string,
): Promise<string[]> {
  const bot = await createRepos(prisma).getBot(actor, botId);
  return bot.thread ? [bot.thread.id] : [];
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

/** `approval` when the block carries an `approvalEffectId`, `skill_offer` for an offered
 * skill, otherwise `question` (a standalone question, or a choice offering options). */
function classifyAskKind(block: AskBlock | ChoiceBlock): AskKind {
  if (block.kind === "ask" && block.approvalEffectId) return "approval";
  if (block.kind === "ask" && block.skillOffer) return "skill_offer";
  return "question";
}

function toAskChoices(block: AskBlock | ChoiceBlock): Ask["choices"] {
  if (block.kind === "ask") {
    return (block.actions ?? []).map((action) => ({ id: action.id, label: action.label }));
  }
  return block.options.map((option) => ({ id: option.id, label: option.label }));
}

/** Open Asks of the Conversation's thread, newest first. */
async function loadThreadAsks(prisma: PrismaClient, actor: Actor, botId: string): Promise<Ask[]> {
  const threadIds = await loadAskThreadIds(prisma, actor, botId);
  const rows = await queryAskCandidates(prisma, threadIds);
  const asks: Ask[] = [];
  for (const row of rows) {
    if (!row.runId) continue;
    const parsed = MessageBlockSchema.array().safeParse(row.blocks);
    if (!parsed.success) continue;
    const block = pendingAskBlock(parsed.data);
    if (!block) continue;
    asks.push({
      id: row.id,
      runId: row.runId,
      kind: classifyAskKind(block),
      goalId: null,
      goalTitle: null,
      text: block.kind === "ask" ? block.text : block.question,
      detail: block.kind === "ask" ? block.detail : block.subtitle,
      choices: toAskChoices(block),
      input: block.kind === "ask" ? (block.input ?? null) : null,
      createdAt: row.createdAt.toISOString(),
    });
  }
  return asks;
}

export interface AsksDeps {
  prisma: PrismaClient;
}

/** Shared by `asks.list` and `asks.count`: the engine's inbox for this Muse, or without the
 * engine the Conversation's own Asks. */
async function loadAsks(
  deps: AsksDeps,
  engine: OmnigentClientConfig | undefined,
  actor: Actor,
  botId: string,
): Promise<Ask[]> {
  return engine
    ? engineListAsks(deps, engine, actor, botId)
    : loadThreadAsks(deps.prisma, actor, botId);
}

export const listAsks = loadAsks;

export async function countAsks(
  deps: AsksDeps,
  engine: OmnigentClientConfig | undefined,
  actor: Actor,
  botId: string,
): Promise<{ count: number }> {
  return { count: (await loadAsks(deps, engine, actor, botId)).length };
}

export interface AnswerAskDeps {
  prisma: PrismaClient;
  events: ThreadEvents;
  jobs: JobPublisher;
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
 * Answer an Ask, however it answers: an engine ask on the engine, a skill offer directly, and
 * everything else through the same commit path `threads.answer` uses
 * (`ThreadEvents.answerRunInput`), where `askId` is the message id (see `Ask.id`).
 */
export async function answerAsk(
  deps: AnswerAskDeps,
  engine: OmnigentClientConfig | undefined,
  actor: Actor,
  input: { askId: string; runId: string; answer: string; username?: string },
): Promise<{ ok: true }> {
  if (engine && isEngineAskId(input.askId)) return engineAnswerAsk(deps, engine, actor, input);
  const message = await deps.prisma.message.findFirst({
    where: { id: input.askId, runId: input.runId, role: "bot" },
    select: { id: true, threadId: true, blocks: true, thread: { select: { botId: true } } },
  });
  if (!message) throw new IsolationError();
  const targetBotId = message.thread.botId;
  if (!targetBotId) throw new IsolationError();
  // Authorizes like every other bot-scoped route: throws unless `targetBotId` is one of this
  // actor's own bots in their own Space.
  await createRepos(deps.prisma).getBot(actor, targetBotId);

  const parsedBlocks = MessageBlockSchema.array().safeParse(message.blocks);
  const pending = parsedBlocks.success ? pendingAskBlock(parsedBlocks.data) : null;
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
