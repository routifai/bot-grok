// Approvals the engine holds for the person (docs/muse/PLAN.md, Q5): the Asks they appear as,
// answering them, and the standing rules and daily spending cap Settings shows. Nova keeps no
// approval rows: the engine decides what needs asking, remembers what the person always allows
// and never lets an unanswered one through.
import {
  answerOmnigentApproval,
  createChatOwnershipResolver,
  deleteOmnigentApprovalRule,
  getOmnigentApprovalSettings,
  listOmnigentApprovalRules,
  listOmnigentApprovals,
  type OmnigentApproval,
  type OmnigentClientConfig,
  putOmnigentApprovalSettings,
} from "@aiden/adapters";
import type { Actor, ApprovalSpending, ApprovalStandingRule, Ask } from "@aiden/contracts";
import type { PrismaClient } from "@aiden/db";
import { ORPCError } from "@orpc/server";
import { onSuperChat } from "./omnigent-errors.js";

export interface EngineApprovalsDeps {
  prisma: PrismaClient;
}

const iso = (epochSeconds: number) => new Date(epochSeconds * 1000).toISOString();

async function ownMuse(
  deps: EngineApprovalsDeps,
  actor: Actor,
  botId: string,
): Promise<{ email: string; superSessionId: string | null }> {
  const [bot, user, session] = await Promise.all([
    deps.prisma.bot.findFirst({
      where: { id: botId, spaceId: actor.spaceId, userId: actor.userId },
      select: { id: true },
    }),
    deps.prisma.user.findUnique({ where: { id: actor.userId }, select: { email: true } }),
    deps.prisma.omnigentSession.findUnique({
      where: { botId },
      select: { omnigentSessionId: true },
    }),
  ]);
  if (!bot || !user) throw new ORPCError("NOT_FOUND", { message: "Muse not found" });
  return { email: user.email, superSessionId: session?.omnigentSessionId ?? null };
}

/** The Ask an engine approval shows as. The card names what will happen; "Always allow" names
 * the standing rule it would save, and is left out when the engine says it cannot apply. */
function toAsk(approval: OmnigentApproval, chatId: string | null): Ask {
  const choices = [{ id: "once", label: "Allow once" }];
  if (approval.can_always) choices.push({ id: "always", label: "Always allow" });
  choices.push({ id: "deny", label: "Deny" });
  return {
    id: approval.id,
    runId: approval.session_id,
    kind: "approval",
    goalId: null,
    goalTitle: null,
    text: approval.summary,
    detail: approval.can_always ? `Always allow: ${approval.always_label}` : undefined,
    choices,
    input: null,
    createdAt: iso(approval.created_at),
    approval: { chatId },
  };
}

/** The approvals waiting on this Muse's person, from its Conversation, Side Chats and Helpers. */
export async function engineApprovalAsks(
  deps: EngineApprovalsDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  botId: string,
): Promise<Ask[]> {
  const { email, superSessionId } = await ownMuse(deps, actor, botId);
  if (!superSessionId) return [];
  const waiting = await listOmnigentApprovals(client, email);
  const asks: Ask[] = [];
  const ownershipOf = createChatOwnershipResolver(client, email, [
    { botId, omnigentSessionId: superSessionId },
  ]);
  for (const approval of waiting) {
    if (approval.session_id === superSessionId) {
      asks.push(toAsk(approval, null));
      continue;
    }
    const owner = await ownershipOf(approval.session_id);
    if (owner) asks.push(toAsk(approval, owner.kind === "side_chat" ? approval.session_id : null));
  }
  return asks;
}

/** Answers an engine approval; `null` when `askId` is not one of the actor's waiting approvals
 * (so the caller can say so). `answer` is `once`, `always` or `deny`. */
export async function engineAnswerApproval(
  deps: EngineApprovalsDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  input: { askId: string; runId: string; answer: string },
): Promise<{ ok: true } | null> {
  if (!input.askId.startsWith("elicit_")) return null;
  if (input.answer !== "once" && input.answer !== "always" && input.answer !== "deny") {
    throw new ORPCError("BAD_REQUEST", { message: "Answer once, always or deny." });
  }
  const user = await deps.prisma.user.findUnique({
    where: { id: actor.userId },
    select: { email: true },
  });
  if (!user) throw new ORPCError("NOT_FOUND", { message: "Person not found" });
  await onSuperChat(answerOmnigentApproval(client, user.email, input.askId, input.answer));
  return { ok: true as const };
}

const NO_ENGINE = "Approvals need the engine";

export async function listApprovalRules(
  deps: EngineApprovalsDeps,
  client: OmnigentClientConfig | undefined,
  actor: Actor,
  botId: string,
): Promise<{ rules: ApprovalStandingRule[]; spending: ApprovalSpending }> {
  if (!client) throw new ORPCError("SERVICE_UNAVAILABLE", { message: NO_ENGINE });
  const { email } = await ownMuse(deps, actor, botId);
  const [rules, settings] = await onSuperChat(
    Promise.all([
      listOmnigentApprovalRules(client, email),
      getOmnigentApprovalSettings(client, email),
    ]),
  );
  return {
    rules: rules.map((rule) => ({
      id: rule.id,
      label: rule.label,
      decision: rule.decision,
      createdAt: rule.created_at,
    })),
    spending: { dailyCapUsd: settings.daily_cap_usd, spentTodayUsd: settings.spent_today_usd },
  };
}

export async function revokeApprovalRule(
  deps: EngineApprovalsDeps,
  client: OmnigentClientConfig | undefined,
  actor: Actor,
  input: { botId: string; ruleId: string },
): Promise<{ ok: true }> {
  if (!client) throw new ORPCError("SERVICE_UNAVAILABLE", { message: NO_ENGINE });
  const { email } = await ownMuse(deps, actor, input.botId);
  await onSuperChat(deleteOmnigentApprovalRule(client, email, input.ruleId));
  return { ok: true as const };
}

export async function setApprovalSpending(
  deps: EngineApprovalsDeps,
  client: OmnigentClientConfig | undefined,
  actor: Actor,
  input: { botId: string; dailyCapUsd: number },
): Promise<ApprovalSpending> {
  if (!client) throw new ORPCError("SERVICE_UNAVAILABLE", { message: NO_ENGINE });
  const { email } = await ownMuse(deps, actor, input.botId);
  const settings = await onSuperChat(putOmnigentApprovalSettings(client, email, input.dailyCapUsd));
  return { dailyCapUsd: settings.daily_cap_usd, spentTodayUsd: settings.spent_today_usd };
}
