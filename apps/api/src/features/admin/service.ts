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
  await onModels(
    setOmnigentUserSuspended(target.client, target.email, input.userId, input.suspended),
  );
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
