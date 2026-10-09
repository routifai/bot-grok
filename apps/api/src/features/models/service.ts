// The engine's model layer for the signed-in person (docs/adr: the engine owns models, keys and
// budgets). Nova keeps no key, price or budget row here: it asks the engine as the person, maps
// the answer to the web's shapes and turns the engine's public error codes into typed errors
// the web renders (`data.code`). Admin calls are gated twice: here (the engine's own idea of an
// admin, `GET /v1/me`) and by the engine, which refuses anyone else.
import {
  deleteOmnigentModelConnection,
  deleteOmnigentUser,
  getOmnigentAdminUsage,
  getOmnigentBudget,
  getOmnigentIdentity,
  getOmnigentModelOverlay,
  getOmnigentModelPreferences,
  getOmnigentSessionModel,
  listOmnigentAdminModelCatalog,
  listOmnigentAdminUsers,
  listOmnigentModelConnections,
  listOmnigentModels,
  OmnigentApiError,
  type OmnigentBudget,
  type OmnigentClientConfig,
  type OmnigentModelCatalog,
  type OmnigentModelConnection,
  omnigentErrorCopy,
  putOmnigentBudget,
  putOmnigentModelConnection,
  putOmnigentModelOverlay,
  putOmnigentModelPreferences,
  setOmnigentSessionModel,
  setOmnigentUserSuspended,
} from "@nova/adapters";
import type {
  Actor,
  EngineAdminUsage,
  EngineAdminUser,
  EngineBudget,
  EngineModelCatalog,
  EngineModelConnection,
  EngineModelsStatus,
} from "@nova/contracts";
import type { PrismaClient } from "@nova/db";
import { ORPCError } from "@orpc/server";

export interface EngineModelsDeps {
  prisma: PrismaClient;
}

type OrpcCode =
  | "BAD_REQUEST"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "PRECONDITION_FAILED"
  | "BAD_GATEWAY"
  | "SERVICE_UNAVAILABLE";

/** The RPC status of each engine code the model layer can answer with. */
const STATUS: Record<string, OrpcCode> = {
  model_key_required: "PRECONDITION_FAILED",
  model_not_supported: "BAD_REQUEST",
  model_budget_exhausted: "FORBIDDEN",
  model_provider_unreachable: "BAD_GATEWAY",
  account_suspended: "FORBIDDEN",
  forbidden: "FORBIDDEN",
  not_found: "NOT_FOUND",
  invalid_input: "BAD_REQUEST",
  superchat_not_configured: "SERVICE_UNAVAILABLE",
};

/** Runs an engine call; an engine error becomes an `ORPCError` carrying the engine's public
 * `code` in `data.code` and a message the person can read. The engine's own text is passed on
 * only for `invalid_input` (a key the provider rejected, "you cannot suspend your own
 * account"), where it is written for the person and names no secret. */
export async function onModels<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (error) {
    if (!(error instanceof OmnigentApiError) || !error.code) throw error;
    const status = STATUS[error.code];
    if (!status) throw error;
    const message =
      omnigentErrorCopy(error) ??
      (error.code === "invalid_input" ? error.detail : undefined) ??
      (error.code === "forbidden" ? "Only admins can do that." : "That didn't work.");
    throw new ORPCError(status, { message, data: { code: error.code } });
  }
}

const NO_ENGINE = "Models need the engine";

/** The built-in agents Nova's deployments run the Muse on, and the harness each runs. */
const AGENT_HARNESS: Record<string, { id: string; label: string }> = {
  "nova-claude": { id: "claude-sdk", label: "Claude" },
  "nova-pi": { id: "pi", label: "Pi" },
};
const ALL_HARNESSES = [AGENT_HARNESS["nova-claude"], AGENT_HARNESS["nova-pi"]] as {
  id: string;
  label: string;
}[];

async function person(
  deps: EngineModelsDeps,
  client: OmnigentClientConfig | undefined,
  actor: Actor,
): Promise<{ client: OmnigentClientConfig; email: string }> {
  if (!client) throw new ORPCError("SERVICE_UNAVAILABLE", { message: NO_ENGINE });
  const user = await deps.prisma.user.findUnique({
    where: { id: actor.userId },
    select: { email: true },
  });
  if (!user) throw new ORPCError("NOT_FOUND", { message: "Person not found" });
  return { client, email: user.email };
}

async function admin(
  deps: EngineModelsDeps,
  client: OmnigentClientConfig | undefined,
  actor: Actor,
): Promise<{ client: OmnigentClientConfig; email: string }> {
  const target = await person(deps, client, actor);
  const identity = await onModels(getOmnigentIdentity(target.client, target.email));
  if (!identity.is_admin) {
    throw new ORPCError("FORBIDDEN", {
      message: "Only admins can do that.",
      data: { code: "forbidden" },
    });
  }
  return target;
}

/** The harness this person's Nova runs, from the agent their Muse last reported; both when
 * there is no Muse yet (the deployment decides at the first turn). */
async function harnessesOf(deps: EngineModelsDeps, actor: Actor) {
  const session = await deps.prisma.omnigentSession.findFirst({
    where: { bot: { spaceId: actor.spaceId, userId: actor.userId } },
    select: { agentName: true },
    orderBy: { updatedAt: "desc" },
  });
  const known = session ? AGENT_HARNESS[session.agentName] : undefined;
  return known ? [known] : ALL_HARNESSES;
}

function toConnection(row: OmnigentModelConnection): EngineModelConnection {
  return {
    provider: row.provider,
    hint: row.hint,
    status: row.status,
    validatedAt: row.validated_at,
    label: row.label,
    scope: row.scope,
  };
}

function toCatalog(row: OmnigentModelCatalog): EngineModelCatalog {
  return {
    harness: row.harness,
    status: row.status,
    providerLabel: row.provider_label,
    defaultModel: row.default_model,
    models: row.models.map((model) => ({
      id: model.id,
      label: model.label,
      family: typeof model.family === "string" ? model.family : null,
      isDefault: model.is_default,
      isUserDefault: model.is_user_default,
    })),
    error: row.error ?? null,
  };
}

function toBudget(row: OmnigentBudget): EngineBudget {
  return {
    monthlyLimitUsd: row.monthly_limit_usd,
    atLimit: row.at_limit,
    spentMonthUsd: row.spent_month_usd,
    orgLimitUsd: row.org_limit_usd ?? null,
  };
}

export async function engineModelsStatus(
  deps: EngineModelsDeps,
  client: OmnigentClientConfig | undefined,
  actor: Actor,
): Promise<EngineModelsStatus> {
  if (!client) return { enabled: false, harnesses: [], isAdmin: false, ready: false };
  const { email } = await person(deps, client, actor);
  const harnesses = await harnessesOf(deps, actor);
  const [identity, catalogs] = await Promise.all([
    getOmnigentIdentity(client, email).catch(() => ({ user_id: null, is_admin: false })),
    Promise.all(
      harnesses.map((harness) =>
        listOmnigentModels(client, email, harness.id).catch(() => undefined),
      ),
    ),
  ]);
  return {
    enabled: true,
    harnesses,
    isAdmin: identity.is_admin,
    ready: catalogs.some((catalog) => catalog?.status === "ready"),
  };
}

export async function listEngineConnections(
  deps: EngineModelsDeps,
  client: OmnigentClientConfig | undefined,
  actor: Actor,
): Promise<EngineModelConnection[]> {
  const target = await person(deps, client, actor);
  const rows = await onModels(listOmnigentModelConnections(target.client, target.email, "user"));
  return rows.map(toConnection);
}

export async function connectEngineModel(
  deps: EngineModelsDeps,
  client: OmnigentClientConfig | undefined,
  actor: Actor,
  input: { provider: string; apiKey: string; label?: string },
  scope: "user" | "org" = "user",
): Promise<EngineModelConnection> {
  const target =
    scope === "org" ? await admin(deps, client, actor) : await person(deps, client, actor);
  const row = await onModels(
    putOmnigentModelConnection(target.client, target.email, scope, input.provider, {
      api_key: input.apiKey,
      ...(input.label ? { label: input.label } : {}),
    }),
  );
  return toConnection(row);
}

export async function disconnectEngineModel(
  deps: EngineModelsDeps,
  client: OmnigentClientConfig | undefined,
  actor: Actor,
  provider: string,
  scope: "user" | "org" = "user",
): Promise<{ ok: true }> {
  const target =
    scope === "org" ? await admin(deps, client, actor) : await person(deps, client, actor);
  await onModels(deleteOmnigentModelConnection(target.client, target.email, scope, provider));
  return { ok: true as const };
}

export async function listOrgConnections(
  deps: EngineModelsDeps,
  client: OmnigentClientConfig | undefined,
  actor: Actor,
): Promise<EngineModelConnection[]> {
  const target = await admin(deps, client, actor);
  const rows = await onModels(listOmnigentModelConnections(target.client, target.email, "org"));
  return rows.map(toConnection);
}

export async function engineModelCatalog(
  deps: EngineModelsDeps,
  client: OmnigentClientConfig | undefined,
  actor: Actor,
  harness: string,
): Promise<EngineModelCatalog> {
  const target = await person(deps, client, actor);
  return toCatalog(await onModels(listOmnigentModels(target.client, target.email, harness)));
}

export async function engineModelPreferences(
  deps: EngineModelsDeps,
  client: OmnigentClientConfig | undefined,
  actor: Actor,
): Promise<Record<string, string>> {
  const target = await person(deps, client, actor);
  return onModels(getOmnigentModelPreferences(target.client, target.email));
}

/** Sets one harness's default and keeps the person's others (the engine replaces the map). */
export async function setEngineDefaultModel(
  deps: EngineModelsDeps,
  client: OmnigentClientConfig | undefined,
  actor: Actor,
  input: { harness: string; model: string },
): Promise<Record<string, string>> {
  const target = await person(deps, client, actor);
  const current = await onModels(getOmnigentModelPreferences(target.client, target.email));
  return onModels(
    putOmnigentModelPreferences(target.client, target.email, {
      ...current,
      [input.harness]: input.model,
    }),
  );
}

export async function engineBudget(
  deps: EngineModelsDeps,
  client: OmnigentClientConfig | undefined,
  actor: Actor,
): Promise<EngineBudget> {
  const target = await person(deps, client, actor);
  return toBudget(await onModels(getOmnigentBudget(target.client, target.email, "user")));
}

export async function setEngineBudget(
  deps: EngineModelsDeps,
  client: OmnigentClientConfig | undefined,
  actor: Actor,
  input: { monthlyLimitUsd: number | null; atLimit: "stop" | "ask" },
): Promise<EngineBudget> {
  const target = await person(deps, client, actor);
  return toBudget(
    await onModels(
      putOmnigentBudget(target.client, target.email, "user", {
        monthly_limit_usd: input.monthlyLimitUsd,
        at_limit: input.atLimit,
      }),
    ),
  );
}

async function museSession(deps: EngineModelsDeps, actor: Actor, botId: string) {
  const bot = await deps.prisma.bot.findFirst({
    where: { id: botId, spaceId: actor.spaceId, userId: actor.userId },
    select: { omnigentSession: { select: { omnigentSessionId: true, agentName: true } } },
  });
  if (!bot) throw new ORPCError("NOT_FOUND", { message: "Muse not found" });
  return bot.omnigentSession;
}

/** The model this Muse's Conversation is pinned to (`null`: the person's default) and the list
 * to pick from, for the harness the Conversation actually runs. */
export async function engineSessionModel(
  deps: EngineModelsDeps,
  client: OmnigentClientConfig | undefined,
  actor: Actor,
  botId: string,
) {
  const target = await person(deps, client, actor);
  const session = await museSession(deps, actor, botId);
  const harness = (session && AGENT_HARNESS[session.agentName]?.id) || ALL_HARNESSES[0]?.id || "";
  const [model, catalog] = await Promise.all([
    session
      ? onModels(getOmnigentSessionModel(target.client, target.email, session.omnigentSessionId))
      : Promise.resolve(null),
    onModels(listOmnigentModels(target.client, target.email, harness)),
  ]);
  return { harness, model, catalog: toCatalog(catalog) };
}

export async function setEngineSessionModel(
  deps: EngineModelsDeps,
  client: OmnigentClientConfig | undefined,
  actor: Actor,
  input: { botId: string; model: string | null },
): Promise<{ ok: true }> {
  const target = await person(deps, client, actor);
  const session = await museSession(deps, actor, input.botId);
  if (!session) throw new ORPCError("NOT_FOUND", { message: "Say hello first." });
  await onModels(
    setOmnigentSessionModel(target.client, target.email, session.omnigentSessionId, input.model),
  );
  return { ok: true as const };
}

export async function listAdminUsers(
  deps: EngineModelsDeps,
  client: OmnigentClientConfig | undefined,
  actor: Actor,
): Promise<EngineAdminUser[]> {
  const target = await admin(deps, client, actor);
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
  const target = await admin(deps, client, actor);
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
  const target = await admin(deps, client, actor);
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
  const target = await admin(deps, client, actor);
  await onModels(deleteOmnigentUser(target.client, target.email, userId));
  return { ok: true as const };
}

export async function adminOverlay(
  deps: EngineModelsDeps,
  client: OmnigentClientConfig | undefined,
  actor: Actor,
) {
  const target = await admin(deps, client, actor);
  return onModels(getOmnigentModelOverlay(target.client, target.email));
}

export async function setAdminOverlay(
  deps: EngineModelsDeps,
  client: OmnigentClientConfig | undefined,
  actor: Actor,
  harnesses: Record<string, { allow: string[] | null; default: string | null }>,
) {
  const target = await admin(deps, client, actor);
  return onModels(putOmnigentModelOverlay(target.client, target.email, harnesses));
}

export async function adminBudget(
  deps: EngineModelsDeps,
  client: OmnigentClientConfig | undefined,
  actor: Actor,
  next?: { monthlyLimitUsd: number | null; atLimit: "stop" | "ask" },
) {
  const target = await admin(deps, client, actor);
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
  const target = await admin(deps, client, actor);
  const row = await onModels(listOmnigentAdminModelCatalog(target.client, target.email, harness));
  return {
    harness: row.harness,
    status: row.status,
    defaultModel: row.default_model,
    models: row.models,
  };
}
