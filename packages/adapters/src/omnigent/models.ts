// The engine's model layer (engine/omnigent/omnigent/superchat/models/*): a person's provider
// keys, the models their connection serves, their Default and Light per harness and their budget.
// Shapes are the engine's; apps/api maps them.
import type { OmnigentClientConfig } from "./client/core.js";
import { omnigentHeaders, throwOnError } from "./client/core.js";

export type OmnigentModelScope = "user" | "org";

export interface OmnigentModelConnection {
  provider: string;
  hint: string;
  status: string;
  validated_at: number | null;
  label: string | null;
  scope: OmnigentModelScope;
}

export interface OmnigentModelRow {
  id: string;
  label: string;
  family?: string | null;
  is_default: boolean;
  is_user_default: boolean;
  is_light?: boolean;
  [key: string]: unknown;
}

export interface OmnigentModelCatalog {
  harness: string;
  status: string;
  provider_label: string | null;
  default_model: string | null;
  light_model?: string | null;
  light_pick?: string | null;
  automatic_light_model?: string | null;
  models: OmnigentModelRow[];
  error?: string;
}

export interface OmnigentBudget {
  monthly_limit_usd: number | null;
  at_limit: "stop" | "ask";
  spent_month_usd: number;
  period_start?: string;
  org_limit_usd?: number | null;
  org_at_limit?: "stop" | "ask" | null;
  org_spent_month_usd?: number;
}

/** An upstream the engine has configured: what a key can be for. */
export interface OmnigentModelProvider {
  provider: string;
  label: string;
  operator_key: boolean;
}

async function call<T>(
  config: OmnigentClientConfig,
  email: string,
  what: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(new URL(path, config.baseUrl), {
    method: init.method ?? "GET",
    headers: omnigentHeaders(config, email),
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  await throwOnError(response, what, config.secrets);
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

const seg = encodeURIComponent;

const CONNECTIONS = "/v1/me/model-connections";

/** The person's own provider keys. */
export async function listOmnigentModelConnections(
  config: OmnigentClientConfig,
  email: string,
): Promise<OmnigentModelConnection[]> {
  return (
    await call<{ data: OmnigentModelConnection[] }>(
      config,
      email,
      "list model connections",
      CONNECTIONS,
    )
  ).data;
}

/** The engine probes the key with the provider before sealing it. */
export async function putOmnigentModelConnection(
  config: OmnigentClientConfig,
  email: string,
  provider: string,
  body: { api_key: string; label?: string },
): Promise<OmnigentModelConnection> {
  return call(config, email, "save model connection", `${CONNECTIONS}/${seg(provider)}`, {
    method: "PUT",
    body,
  });
}

export async function deleteOmnigentModelConnection(
  config: OmnigentClientConfig,
  email: string,
  provider: string,
): Promise<void> {
  await call(config, email, "remove model connection", `${CONNECTIONS}/${seg(provider)}`, {
    method: "DELETE",
  });
}

/** `GET /v1/me/model-providers`: the engine's configured upstreams, in the order it lists them. */
export async function listOmnigentModelProviders(
  config: OmnigentClientConfig,
  email: string,
): Promise<OmnigentModelProvider[]> {
  return (
    await call<{ data: OmnigentModelProvider[] }>(
      config,
      email,
      "list model providers",
      "/v1/me/model-providers",
    )
  ).data;
}

export async function listOmnigentModels(
  config: OmnigentClientConfig,
  email: string,
  harness: string,
): Promise<OmnigentModelCatalog> {
  return call(config, email, "list models", `/v1/me/models?harness=${seg(harness)}`);
}

/** The person's own picks per harness: `defaults` (chats) and `light` (quick work). */
export interface OmnigentModelPicks {
  defaults: Record<string, string>;
  light: Record<string, string>;
}

export async function getOmnigentModelPicks(
  config: OmnigentClientConfig,
  email: string,
): Promise<OmnigentModelPicks> {
  const picks = await call<Partial<OmnigentModelPicks>>(
    config,
    email,
    "get model preferences",
    "/v1/me/model-preferences",
  );
  return { defaults: picks.defaults ?? {}, light: picks.light ?? {} };
}

/** Replaces the maps given (`defaults`, `light`); the engine keeps a map left out. */
export async function putOmnigentModelPicks(
  config: OmnigentClientConfig,
  email: string,
  picks: Partial<OmnigentModelPicks>,
): Promise<OmnigentModelPicks> {
  const saved = await call<Partial<OmnigentModelPicks>>(
    config,
    email,
    "set model preferences",
    "/v1/me/model-preferences",
    { method: "PUT", body: picks },
  );
  return { defaults: saved.defaults ?? {}, light: saved.light ?? {} };
}

/** The person's own budget (`/v1/me/budget`), with the organization's cap read-only. */
export async function getOmnigentBudget(
  config: OmnigentClientConfig,
  email: string,
): Promise<OmnigentBudget> {
  return call(config, email, "get budget", "/v1/me/budget");
}

export async function putOmnigentBudget(
  config: OmnigentClientConfig,
  email: string,
  budget: { monthly_limit_usd: number | null; at_limit: "stop" | "ask" },
): Promise<OmnigentBudget> {
  return call(config, email, "set budget", "/v1/me/budget", {
    method: "PUT",
    body: budget,
  });
}

export async function getOmnigentSessionModel(
  config: OmnigentClientConfig,
  email: string,
  sessionId: string,
): Promise<string | null> {
  const session = await call<{ model_override?: string | null }>(
    config,
    email,
    "get session model",
    `/v1/sessions/${seg(sessionId)}?include_items=false&include_liveness=false&include_usage=false`,
  );
  return session.model_override ?? null;
}

/** `PATCH /v1/sessions/{id}` with `model_override`; `null` returns to the default. */
export async function setOmnigentSessionModel(
  config: OmnigentClientConfig,
  email: string,
  sessionId: string,
  model: string | null,
): Promise<void> {
  await call(config, email, "set session model", `/v1/sessions/${seg(sessionId)}`, {
    method: "PATCH",
    body: { model_override: model ?? "default" },
  });
}

// Account safety for signups (quarantine and a clean approval): the engine's account pause and
// reset, called as the deployment owner and refused by the engine unless it counts them an admin.

export async function setOmnigentUserSuspended(
  config: OmnigentClientConfig,
  email: string,
  userId: string,
  suspended: boolean,
): Promise<void> {
  await call(
    config,
    email,
    suspended ? "suspend user" : "resume user",
    `/v1/admin/users/${seg(userId)}/${suspended ? "suspend" : "resume"}`,
    { method: "POST" },
  );
}

export async function deleteOmnigentUser(
  config: OmnigentClientConfig,
  email: string,
  userId: string,
): Promise<void> {
  await call(config, email, "delete user", `/v1/admin/users/${seg(userId)}`, {
    method: "DELETE",
  });
}
