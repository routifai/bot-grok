import type { OmnigentClientConfig } from "./core.js";
import { omnigentHeaders, throwOnError } from "./core.js";

export type OmnigentApprovalCategory = "send" | "post" | "delete" | "spend" | "upload" | "share";

/** A standing rule: this kind of action, on this target, needs no asking. */
export interface OmnigentApprovalRule {
  id: string;
  category: OmnigentApprovalCategory;
  target: string;
  label: string;
  decision: "allow" | "deny";
  created_at: number;
}

export interface OmnigentApprovalSettings {
  daily_cap_usd: number;
  spent_today_usd: number;
}

/** `GET /v1/me/approval-rules` — the standing rules, newest first. */
export async function listOmnigentApprovalRules(
  config: OmnigentClientConfig,
  email: string,
): Promise<OmnigentApprovalRule[]> {
  const response = await fetch(new URL("/v1/me/approval-rules", config.baseUrl), {
    headers: omnigentHeaders(config, email),
  });
  await throwOnError(response, "list approval rules", config.secrets);
  return ((await response.json()) as { rules?: OmnigentApprovalRule[] }).rules ?? [];
}

/** `DELETE /v1/me/approval-rules/{id}` — revoke a standing rule. */
export async function deleteOmnigentApprovalRule(
  config: OmnigentClientConfig,
  email: string,
  id: string,
): Promise<void> {
  const response = await fetch(
    new URL(`/v1/me/approval-rules/${encodeURIComponent(id)}`, config.baseUrl),
    { method: "DELETE", headers: omnigentHeaders(config, email) },
  );
  await throwOnError(response, "revoke approval rule", config.secrets);
}

/** `GET`/`PUT /v1/me/approval-settings` — the daily spending cap (0 = always ask). */
export async function getOmnigentApprovalSettings(
  config: OmnigentClientConfig,
  email: string,
): Promise<OmnigentApprovalSettings> {
  const response = await fetch(new URL("/v1/me/approval-settings", config.baseUrl), {
    headers: omnigentHeaders(config, email),
  });
  await throwOnError(response, "get approval settings", config.secrets);
  return (await response.json()) as OmnigentApprovalSettings;
}

export async function putOmnigentApprovalSettings(
  config: OmnigentClientConfig,
  email: string,
  dailyCapUsd: number,
): Promise<OmnigentApprovalSettings> {
  const response = await fetch(new URL("/v1/me/approval-settings", config.baseUrl), {
    method: "PUT",
    headers: omnigentHeaders(config, email),
    body: JSON.stringify({ daily_cap_usd: dailyCapUsd }),
  });
  await throwOnError(response, "set approval settings", config.secrets);
  return (await response.json()) as OmnigentApprovalSettings;
}
