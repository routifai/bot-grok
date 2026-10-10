// The engine's model layer for the signed-in person (docs/adr: the engine owns models, keys and
// budgets). Superchat keeps no key, price or budget row here: it asks the engine as the person, maps
// the answer to the web's shapes and turns the engine's public error codes into typed errors
// the web renders (`data.code`).

import { ORPCError } from "@orpc/server";
import {
  deleteOmnigentModelConnection,
  getOmnigentBudget,
  getOmnigentModelPicks,
  getOmnigentSessionModel,
  listOmnigentModelConnections,
  listOmnigentModelProviders,
  listOmnigentModels,
  OmnigentApiError,
  type OmnigentBudget,
  type OmnigentClientConfig,
  type OmnigentModelCatalog,
  type OmnigentModelConnection,
  omnigentErrorCopy,
  putOmnigentBudget,
  putOmnigentModelConnection,
  putOmnigentModelPicks,
  setOmnigentSessionModel,
} from "@superchat/adapters";
import type {
  Actor,
  EngineBudget,
  EngineModelCatalog,
  EngineModelConnection,
  EngineModelProvider,
  EngineModelsStatus,
} from "@superchat/contracts";
import type { PrismaClient } from "@superchat/db";

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
      "That didn't work.";
    throw new ORPCError(status, { message, data: { code: error.code } });
  }
}

const NO_ENGINE = "Models need the engine";

/** The built-in agents Superchat's deployments run the Muse on, and the harness each runs. */
const AGENT_HARNESS: Record<string, { id: string; label: string }> = {
  "superchat-claude": { id: "claude-sdk", label: "Claude" },
  "superchat-pi": { id: "pi", label: "Pi" },
};
const ALL_HARNESSES = [AGENT_HARNESS["superchat-claude"], AGENT_HARNESS["superchat-pi"]] as {
  id: string;
  label: string;
}[];

export async function person(
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

/** The harness this person's Superchat runs, from the agent their Muse last reported; both when
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
    lightModel: row.light_model ?? null,
    lightPick: row.light_pick ?? null,
    automaticLightModel: row.automatic_light_model ?? null,
    models: row.models.map((model) => ({
      id: model.id,
      label: model.label,
      family: typeof model.family === "string" ? model.family : null,
      isDefault: model.is_default,
      isUserDefault: model.is_user_default,
      isLight: model.is_light === true,
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
  if (!client) return { enabled: false, harnesses: [], ready: false };
  const { email } = await person(deps, client, actor);
  const harnesses = await harnessesOf(deps, actor);
  const catalogs = await Promise.all(
    harnesses.map((harness) =>
      listOmnigentModels(client, email, harness.id).catch(() => undefined),
    ),
  );
  return {
    enabled: true,
    harnesses,
    ready: catalogs.some((catalog) => catalog?.status === "ready"),
  };
}

export async function listEngineProviders(
  deps: EngineModelsDeps,
  client: OmnigentClientConfig | undefined,
  actor: Actor,
): Promise<EngineModelProvider[]> {
  const target = await person(deps, client, actor);
  const rows = await onModels(listOmnigentModelProviders(target.client, target.email));
  return rows.map((row) => ({
    provider: row.provider,
    label: row.label,
    operatorKey: row.operator_key,
  }));
}

export async function listEngineConnections(
  deps: EngineModelsDeps,
  client: OmnigentClientConfig | undefined,
  actor: Actor,
): Promise<EngineModelConnection[]> {
  const target = await person(deps, client, actor);
  const rows = await onModels(listOmnigentModelConnections(target.client, target.email));
  return rows.map(toConnection);
}

export async function connectEngineModel(
  deps: EngineModelsDeps,
  client: OmnigentClientConfig | undefined,
  actor: Actor,
  input: { provider: string; apiKey: string; label?: string },
): Promise<EngineModelConnection> {
  const target = await person(deps, client, actor);
  const row = await onModels(
    putOmnigentModelConnection(target.client, target.email, input.provider, {
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
): Promise<{ ok: true }> {
  const target = await person(deps, client, actor);
  await onModels(deleteOmnigentModelConnection(target.client, target.email, provider));
  return { ok: true as const };
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
  return (await onModels(getOmnigentModelPicks(target.client, target.email))).defaults;
}

/** Sets one harness's default and keeps the person's others (the engine replaces the map). */
export async function setEngineDefaultModel(
  deps: EngineModelsDeps,
  client: OmnigentClientConfig | undefined,
  actor: Actor,
  input: { harness: string; model: string },
): Promise<Record<string, string>> {
  const target = await person(deps, client, actor);
  const { defaults } = await onModels(getOmnigentModelPicks(target.client, target.email));
  const saved = await onModels(
    putOmnigentModelPicks(target.client, target.email, {
      defaults: { ...defaults, [input.harness]: input.model },
    }),
  );
  return saved.defaults;
}

/** Sets one harness's Light model (`null`: back to automatic) and keeps the others. */
export async function setEngineLightModel(
  deps: EngineModelsDeps,
  client: OmnigentClientConfig | undefined,
  actor: Actor,
  input: { harness: string; model: string | null },
): Promise<Record<string, string>> {
  const target = await person(deps, client, actor);
  const { light } = await onModels(getOmnigentModelPicks(target.client, target.email));
  const others = Object.fromEntries(
    Object.entries(light).filter(([harness]) => harness !== input.harness),
  );
  const saved = await onModels(
    putOmnigentModelPicks(target.client, target.email, {
      light: input.model ? { ...others, [input.harness]: input.model } : others,
    }),
  );
  return saved.light;
}

export async function engineBudget(
  deps: EngineModelsDeps,
  client: OmnigentClientConfig | undefined,
  actor: Actor,
): Promise<EngineBudget> {
  const target = await person(deps, client, actor);
  return toBudget(await onModels(getOmnigentBudget(target.client, target.email)));
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
      putOmnigentBudget(target.client, target.email, {
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
