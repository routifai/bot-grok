// The organization's side of the engine's model layer, admin only: people, usage, suspension, the
// model overlay, the organization budget and its catalog. The admin check and the error mapping
// are the models capability's (its public entry point); the engine refuses anyone else anyway.
import {
  deleteOmnigentUser,
  getOmnigentAdminUsage,
  getOmnigentBudget,
  getOmnigentModelOverlay,
  listOmnigentAdminModelCatalog,
  listOmnigentAdminUsers,
  type OmnigentClientConfig,
  putOmnigentBudget,
  putOmnigentModelOverlay,
  setOmnigentUserSuspended,
} from "@nova/adapters";
import type { Actor, EngineAdminUsage, EngineAdminUser } from "@nova/contracts";
import { ORPCError } from "@orpc/server";
import { adminActor, type EngineModelsDeps, onModels } from "../models/index.js";

export async function listAdminUsers(
  deps: EngineModelsDeps,
  client: OmnigentClientConfig | undefined,
  actor: Actor,
): Promise<EngineAdminUser[]> {
  const target = await adminActor(deps, client, actor);
  const users = await onModels(listOmnigentAdminUsers(target.client, target.email));
  return users.map((user) => ({
    id: user.id,
    email: user.email,
    isAdmin: user.is_admin,
    status: user.status,
    spendMonthUsd: user.spend_month_usd,
    spendTodayUsd: user.spend_today_usd,
    sessionCount: user.session_count,
    providers: user.model_connections.map((connection) => connection.provider),
    budget: {
      monthlyLimitUsd: user.budget.monthly_limit_usd,
      atLimit: user.budget.at_limit,
    },
    computer: user.computer?.state ?? null,
    lastActive: user.last_active,
  }));
}

export async function adminUsage(
  deps: EngineModelsDeps,
  client: OmnigentClientConfig | undefined,
  actor: Actor,
  window: "day" | "month",
): Promise<EngineAdminUsage> {
  const target = await adminActor(deps, client, actor);
  const usage = await onModels(getOmnigentAdminUsage(target.client, target.email, window));
  return {
    window: usage.window,
    totalUsd: usage.total_usd,
    byUser: usage.by_user.map((row) => ({ userId: row.user_id, costUsd: row.cost_usd })),
    byDay: usage.by_day.map((row) => ({ day: row.day, costUsd: row.cost_usd })),
  };
}

export async function setUserSuspended(
  deps: EngineModelsDeps,
  client: OmnigentClientConfig | undefined,
  actor: Actor,
  input: { userId: string; suspended: boolean },
): Promise<{ ok: true }> {
  const target = await adminActor(deps, client, actor);
  // Engine users are identified by email, so match the Nova account by email, and refuse
  // anything but exactly one match rather than guess. Resolve it before touching the engine, so a
  // refusal leaves both sides as they were.
  const matches = await deps.prisma.user.findMany({
    where: { email: { equals: input.userId, mode: "insensitive" } },
    select: { id: true },
  });
  if (matches.length !== 1) {
    throw new ORPCError("NOT_FOUND", { message: "No single matching account" });
  }
  await onModels(
    setOmnigentUserSuspended(target.client, target.email, input.userId, input.suspended),
  );
  // One suspension: the engine stops model use, and Nova stops sign-in and space access. A
  // waiting signup stays in the approval queue, so only active and suspended accounts toggle.
  await deps.prisma.user.updateMany({
    where: { id: matches[0]!.id, status: input.suspended ? "active" : "suspended" },
    data: { status: input.suspended ? "suspended" : "active" },
  });
  return { ok: true as const };
}

export async function deleteEngineUser(
  deps: EngineModelsDeps,
  client: OmnigentClientConfig | undefined,
  actor: Actor,
  userId: string,
): Promise<{ ok: true }> {
  const target = await adminActor(deps, client, actor);
  await onModels(deleteOmnigentUser(target.client, target.email, userId));
  return { ok: true as const };
}

export async function adminOverlay(
  deps: EngineModelsDeps,
  client: OmnigentClientConfig | undefined,
  actor: Actor,
) {
  const target = await adminActor(deps, client, actor);
  return onModels(getOmnigentModelOverlay(target.client, target.email));
}

export async function setAdminOverlay(
  deps: EngineModelsDeps,
  client: OmnigentClientConfig | undefined,
  actor: Actor,
  harnesses: Record<string, { allow: string[] | null; default: string | null }>,
) {
  const target = await adminActor(deps, client, actor);
  return onModels(putOmnigentModelOverlay(target.client, target.email, harnesses));
}

export async function adminBudget(
  deps: EngineModelsDeps,
  client: OmnigentClientConfig | undefined,
  actor: Actor,
  next?: { monthlyLimitUsd: number | null; atLimit: "stop" | "ask" },
) {
  const target = await adminActor(deps, client, actor);
  const row = await onModels(
    next
      ? putOmnigentBudget(target.client, target.email, "org", {
          monthly_limit_usd: next.monthlyLimitUsd,
          at_limit: next.atLimit,
        })
      : getOmnigentBudget(target.client, target.email, "org"),
  );
  return {
    monthlyLimitUsd: row.monthly_limit_usd,
    atLimit: row.at_limit,
    spentMonthUsd: row.spent_month_usd,
  };
}

export async function adminModelCatalog(
  deps: EngineModelsDeps,
  client: OmnigentClientConfig | undefined,
  actor: Actor,
  harness: string,
) {
  const target = await adminActor(deps, client, actor);
  const row = await onModels(listOmnigentAdminModelCatalog(target.client, target.email, harness));
  return {
    harness: row.harness,
    status: row.status,
    defaultModel: row.default_model,
    models: row.models,
  };
}

type EngineOutcome = "done" | "no-engine" | "no-owner";

async function engineAdminEmail(deps: EngineModelsDeps): Promise<string | null> {
  const settings = await deps.prisma.deploymentSettings.findUnique({
    where: { id: "default" },
    select: { ownerUserId: true },
  });
  if (!settings?.ownerUserId) return null;
  const owner = await deps.prisma.user.findUnique({
    where: { id: settings.ownerUserId },
    select: { email: true },
  });
  return owner?.email ?? null;
}

/**
 * Stop (or resume) an account's engine-side work, the way suspension does: scheduled tasks and
 * in-flight runs live in the engine, which only an engine admin can pause. The deployment owner is
 * the admin identity, so the owner must also be an engine admin; an engine refusal throws, and
 * "no engine" or "no owner" is reported so the caller can warn. Engine users are named by email.
 */
export async function setEngineAccountSuspended(
  deps: EngineModelsDeps,
  client: OmnigentClientConfig | undefined,
  email: string,
  suspended: boolean,
): Promise<EngineOutcome> {
  if (!client) return "no-engine";
  const admin = await engineAdminEmail(deps);
  if (!admin) return "no-owner";
  await onModels(setOmnigentUserSuspended(client, admin, email, suspended));
  return "done";
}

/**
 * Reset an engine account instead of resuming it. The engine's user delete removes the person's
 * sessions, managed Computers, keys, scheduled tasks and account, and forgets their long-term
 * memory; the account is recreated, empty, on next use. This is what a clean approval after a
 * quarantine needs: a squatter's memory and schedules must not come back with the same email.
 */
export async function resetEngineAccount(
  deps: EngineModelsDeps,
  client: OmnigentClientConfig | undefined,
  email: string,
): Promise<EngineOutcome> {
  if (!client) return "no-engine";
  const admin = await engineAdminEmail(deps);
  if (!admin) return "no-owner";
  await onModels(deleteOmnigentUser(client, admin, email));
  return "done";
}
