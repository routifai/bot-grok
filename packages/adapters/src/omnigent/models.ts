// The engine's model layer (engine/omnigent/omnigent/model_credentials/*): a person's provider
// keys, the models their connection serves, their default per harness, their budget, and the
// organization's side of each (admin only). Shapes are the engine's; apps/api maps them.
import type { OmnigentClientConfig } from "./core.js";
import { omnigentHeaders, throwOnError } from "./core.js";

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
  [key: string]: unknown;
}

export interface OmnigentModelCatalog {
  harness: string;
  status: string;
  provider_label: string | null;
  default_model: string | null;
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

export interface OmnigentOverlayEntry {
  allow: string[] | null;
  default: string | null;
}

export interface OmnigentAdminUser {
  id: string;
  email: string | null;
  is_admin: boolean;
  created_at: number | null;
  last_login_at: number | null;
  last_active: number | null;
  status: "active" | "suspended";
  suspended_at: number | null;
  spend_month_usd: number;
  spend_today_usd: number;
  session_count: number;
  model_connections: { provider: string; hint: string; status: string }[];
  budget: { monthly_limit_usd: number | null; at_limit: "stop" | "ask" };
  computer: { name: string; state: "online" | "offline"; managed: boolean } | null;
}

export interface OmnigentAdminUsage {
  window: "day" | "month";
  period_start: string;
  total_usd: number;
  by_user: { user_id: string; cost_usd: number }[];
  by_day: { day: string; cost_usd: number }[];
  org_budget: { monthly_limit_usd: number | null; at_limit: "stop" | "ask" };
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

/** The caller's identity and whether the engine counts them an admin (`GET /v1/me`; the engine
 * also promotes a listed admin on this call). */
export async function getOmnigentIdentity(
  config: OmnigentClientConfig,
  email: string,
): Promise<{ user_id: string | null; is_admin: boolean }> {
  return call(config, email, "get identity", "/v1/me");
}

/** Personal (`/v1/me/...`) or organization (`/v1/admin/...`, admin only) provider keys. */
export async function listOmnigentModelConnections(
  config: OmnigentClientConfig,
  email: string,
  scope: OmnigentModelScope,
): Promise<OmnigentModelConnection[]> {
  const base = scope === "org" ? "/v1/admin/model-connections" : "/v1/me/model-connections";
  return (
    await call<{ data: OmnigentModelConnection[] }>(config, email, "list model connections", base)
  ).data;
}

/** The engine probes the key with the provider before sealing it. */
export async function putOmnigentModelConnection(
  config: OmnigentClientConfig,
  email: string,
  scope: OmnigentModelScope,
  provider: string,
  body: { api_key: string; label?: string },
): Promise<OmnigentModelConnection> {
  const base = scope === "org" ? "/v1/admin/model-connections" : "/v1/me/model-connections";
  return call(config, email, "save model connection", `${base}/${seg(provider)}`, {
    method: "PUT",
    body,
  });
}

export async function deleteOmnigentModelConnection(
  config: OmnigentClientConfig,
  email: string,
  scope: OmnigentModelScope,
  provider: string,
): Promise<void> {
  const base = scope === "org" ? "/v1/admin/model-connections" : "/v1/me/model-connections";
  await call(config, email, "remove model connection", `${base}/${seg(provider)}`, {
    method: "DELETE",
  });
}

export async function listOmnigentModels(
  config: OmnigentClientConfig,
  email: string,
  harness: string,
): Promise<OmnigentModelCatalog> {
  return call(config, email, "list models", `/v1/me/models?harness=${seg(harness)}`);
}

export async function getOmnigentModelPreferences(
  config: OmnigentClientConfig,
  email: string,
): Promise<Record<string, string>> {
  return (
    await call<{ defaults: Record<string, string> }>(
      config,
      email,
      "get model preferences",
      "/v1/me/model-preferences",
    )
  ).defaults;
}

/** Replaces the whole `{harness: model}` map. */
export async function putOmnigentModelPreferences(
  config: OmnigentClientConfig,
  email: string,
  defaults: Record<string, string>,
): Promise<Record<string, string>> {
  return (
    await call<{ defaults: Record<string, string> }>(
      config,
      email,
      "set model preferences",
      "/v1/me/model-preferences",
      { method: "PUT", body: { defaults } },
    )
  ).defaults;
}

/** `/v1/me/budget` (the person's own) or `/v1/admin/budget` (the organization's, admin only). */
export async function getOmnigentBudget(
  config: OmnigentClientConfig,
  email: string,
  scope: OmnigentModelScope,
): Promise<OmnigentBudget> {
  return call(config, email, "get budget", scope === "org" ? "/v1/admin/budget" : "/v1/me/budget");
}

export async function putOmnigentBudget(
  config: OmnigentClientConfig,
  email: string,
  scope: OmnigentModelScope,
  budget: { monthly_limit_usd: number | null; at_limit: "stop" | "ask" },
): Promise<OmnigentBudget> {
  return call(config, email, "set budget", scope === "org" ? "/v1/admin/budget" : "/v1/me/budget", {
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

export async function getOmnigentModelOverlay(
  config: OmnigentClientConfig,
  email: string,
): Promise<Record<string, OmnigentOverlayEntry>> {
  return (
    await call<{ harnesses: Record<string, OmnigentOverlayEntry> }>(
      config,
      email,
      "get model overlay",
      "/v1/admin/models",
    )
  ).harnesses;
}

export async function putOmnigentModelOverlay(
  config: OmnigentClientConfig,
  email: string,
  harnesses: Record<string, OmnigentOverlayEntry>,
): Promise<Record<string, OmnigentOverlayEntry>> {
  return (
    await call<{ harnesses: Record<string, OmnigentOverlayEntry> }>(
      config,
      email,
      "set model overlay",
      "/v1/admin/models",
      { method: "PUT", body: { harnesses } },
    )
  ).harnesses;
}

/** The binding's whole list for a harness, before the organization's allowlist narrows it. */
export async function listOmnigentAdminModelCatalog(
  config: OmnigentClientConfig,
  email: string,
  harness: string,
): Promise<{
  harness: string;
  status: string;
  default_model: string | null;
  models: { id: string; label: string; family: string | null }[];
}> {
  return call(
    config,
    email,
    "list model catalog",
    `/v1/admin/models/catalog?harness=${seg(harness)}`,
  );
}

export async function listOmnigentAdminUsers(
  config: OmnigentClientConfig,
  email: string,
): Promise<OmnigentAdminUser[]> {
  return (
    await call<{ users: OmnigentAdminUser[] }>(config, email, "list users", "/v1/admin/users")
  ).users;
}

export async function getOmnigentAdminUsage(
  config: OmnigentClientConfig,
  email: string,
  window: "day" | "month",
): Promise<OmnigentAdminUsage> {
  return call(config, email, "get usage", `/v1/admin/usage?window=${window}`);
}

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
