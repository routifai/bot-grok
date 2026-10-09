// The standing approval rules and daily spending cap Settings shows (docs/muse/PLAN.md, Q5).
// Nova keeps no approval rows: the engine decides what needs asking, remembers what the person
// always allows and never lets an unanswered one through. Waiting approvals are Asks
// (./asks.ts).
import {
  deleteOmnigentApprovalRule,
  getOmnigentApprovalSettings,
  listOmnigentApprovalRules,
  type OmnigentClientConfig,
  putOmnigentApprovalSettings,
} from "@nova/adapters";
import type { Actor, ApprovalSpending, ApprovalStandingRule } from "@nova/contracts";
import type { PrismaClient } from "@nova/db";
import { ORPCError } from "@orpc/server";
import { onSuperChat } from "../../omnigent-errors.js";

export interface EngineApprovalsDeps {
  prisma: PrismaClient;
}

async function ownMuse(
  deps: EngineApprovalsDeps,
  actor: Actor,
  botId: string,
): Promise<{ email: string }> {
  const [bot, user] = await Promise.all([
    deps.prisma.bot.findFirst({
      where: { id: botId, spaceId: actor.spaceId, userId: actor.userId },
      select: { id: true },
    }),
    deps.prisma.user.findUnique({ where: { id: actor.userId }, select: { email: true } }),
  ]);
  if (!bot || !user) throw new ORPCError("NOT_FOUND", { message: "Muse not found" });
  return { email: user.email };
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
