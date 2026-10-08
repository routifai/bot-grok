// Asks for Muses on the engine (ADR 0009): the engine's decisions inbox (`GET /v1/me/asks`) is
// the one list of what waits on the person (approvals, plan proposals, blocked Tasks), and
// `POST /v1/me/asks/{id}/answer` answers any of them. The engine sends kinds and choice ids;
// the wording below is Nova's.
import {
  answerOmnigentAsk,
  createChatOwnershipResolver,
  listOmnigentAsks,
  OmnigentApiError,
  type OmnigentAsk,
  type OmnigentClientConfig,
} from "@nova/adapters";
import type { Actor, Ask } from "@nova/contracts";
import type { PrismaClient } from "@nova/db";
import { ORPCError } from "@orpc/server";

export interface EngineAsksDeps {
  prisma: PrismaClient;
}

const iso = (epochSeconds: number) => new Date(epochSeconds * 1000).toISOString();

/** Ids the engine gives its asks: `approval:…`, `proposal:…:…` or `task:…:…`. */
export function isEngineAskId(askId: string): boolean {
  return /^(approval|proposal|task):/.test(askId);
}

const APPROVAL_CHOICES: Record<string, string> = {
  approve_once: "Allow once",
  approve_always: "Always allow",
  deny: "Deny",
};

function proposalChoices(isFirstPlan: boolean): Record<string, string> {
  return isFirstPlan
    ? { accept: "Start this plan", dismiss: "Not now" }
    : { accept: "Use the new plan", dismiss: "Keep current" };
}

function labelled(ask: OmnigentAsk, labels: Record<string, string>): Ask["choices"] {
  return ask.choices.flatMap((choice) => {
    const label = labels[choice.id];
    return label ? [{ id: choice.id, label }] : [];
  });
}

/** An engine ask as the Ask the Feed, the waiting list and the Conversation show. `chatId` is
 * the Side Chat an approval belongs to (`null` for the Conversation and its Helpers). */
function toAsk(ask: OmnigentAsk, chatId: string | null): Ask {
  const createdAt = iso(ask.created_at);
  if (ask.kind === "approval") {
    const { subject } = ask;
    return {
      id: ask.id,
      runId: ask.session_id,
      kind: "approval",
      goalId: null,
      goalTitle: null,
      text: subject.summary,
      detail: subject.can_always ? `Always allow: ${subject.always_label}` : undefined,
      choices: labelled(ask, APPROVAL_CHOICES),
      input: null,
      createdAt,
      approval: { chatId },
    };
  }
  const goalId = ask.objective_id ?? ask.session_id;
  if (ask.kind === "plan_proposal") {
    const { subject } = ask;
    const steps = subject.plan.map((item, index) => `${index + 1}. ${item.title}`);
    return {
      id: ask.id,
      runId: goalId,
      kind: "proposal",
      goalId,
      goalTitle: subject.objective_title,
      text: subject.is_first_plan
        ? `Here's my plan for "${subject.objective_title}"`
        : `Change the plan for "${subject.objective_title}"?`,
      detail: (subject.is_first_plan ? steps : [subject.reason, ...steps]).join("\n"),
      choices: labelled(ask, proposalChoices(subject.is_first_plan)),
      input: null,
      createdAt,
    };
  }
  return {
    id: ask.id,
    runId: goalId,
    kind: "blocked_task",
    goalId,
    goalTitle: ask.subject.objective_title,
    text: ask.subject.note?.trim() || ask.subject.title,
    // The person answers in words: the reply goes into the Task's note.
    choices: [],
    input: "text",
    createdAt,
  };
}

async function emailOf(deps: EngineAsksDeps, actor: Actor): Promise<string> {
  const user = await deps.prisma.user.findUnique({
    where: { id: actor.userId },
    select: { email: true },
  });
  if (!user) throw new ORPCError("NOT_FOUND", { message: "Person not found" });
  return user.email;
}

/** The asks of this Muse: its Goals' (on its Conversation) and the approvals held in its
 * Conversation, Side Chats and Helpers. Newest first, as the engine orders them. */
export async function engineListAsks(
  deps: EngineAsksDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  botId: string,
): Promise<Ask[]> {
  const [bot, session, email] = await Promise.all([
    deps.prisma.bot.findFirst({
      where: { id: botId, spaceId: actor.spaceId, userId: actor.userId },
      select: { id: true },
    }),
    deps.prisma.omnigentSession.findUnique({
      where: { botId },
      select: { omnigentSessionId: true },
    }),
    emailOf(deps, actor),
  ]);
  if (!bot) throw new ORPCError("NOT_FOUND", { message: "Muse not found" });
  if (!session) return [];
  const superSessionId = session.omnigentSessionId;
  const waiting = await listOmnigentAsks(client, email);
  const ownershipOf = createChatOwnershipResolver(client, email, [
    { botId, omnigentSessionId: superSessionId },
  ]);
  const asks: Ask[] = [];
  for (const ask of waiting) {
    if (ask.session_id === superSessionId) {
      asks.push(toAsk(ask, null));
    } else if (ask.kind === "approval") {
      const owner = await ownershipOf(ask.session_id);
      if (owner) asks.push(toAsk(ask, owner.kind === "side_chat" ? ask.session_id : null));
    }
  }
  return asks;
}

/** Answers an engine ask with one of its choice ids; a blocked Task's `answer` is the
 * person's reply. The engine checks the ask is theirs. */
export async function engineAnswerAsk(
  deps: EngineAsksDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  input: { askId: string; answer: string },
): Promise<{ ok: true }> {
  const email = await emailOf(deps, actor);
  const answer = input.askId.startsWith("task:")
    ? { choice: "answer", note: input.answer }
    : { choice: input.answer };
  try {
    await answerOmnigentAsk(client, email, input.askId, answer);
  } catch (error) {
    if (error instanceof OmnigentApiError) {
      if (error.code === "not_found" || error.code === "conflict") {
        throw new ORPCError("CONFLICT", { message: "This prompt is no longer awaiting an answer" });
      }
      if (error.code === "invalid_input") {
        throw new ORPCError("BAD_REQUEST", { message: "Could not submit this answer" });
      }
    }
    throw error;
  }
  return { ok: true as const };
}
