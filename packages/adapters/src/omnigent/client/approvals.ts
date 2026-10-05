import type { OmnigentClientConfig } from "./core.js";
import { omnigentHeaders, throwOnError } from "./core.js";

/** A waiting approval as the engine serves it (`routes/approvals.py` `pending_to_response`). */
export interface OmnigentApproval {
  id: string;
  session_id: string;
  category: "send" | "post" | "delete" | "spend" | "upload" | "share";
  targets: string[];
  summary: string;
  amount_usd: number | null;
  can_always: boolean;
  /** What "always allow" would save, e.g. "Send messages to bob@acme.com". */
  always_label: string;
  created_at: number;
}

/** A standing rule: this kind of action, on this target, needs no asking. */
export interface OmnigentApprovalRule {
  id: string;
  category: OmnigentApproval["category"];
  target: string;
  label: string;
  decision: "allow" | "deny";
  created_at: number;
}

export interface OmnigentApprovalSettings {
  daily_cap_usd: number;
  spent_today_usd: number;
}

/** `GET /v1/me/approvals/pending` — the person's approvals still waiting, oldest first. */
export async function listOmnigentApprovals(
  config: OmnigentClientConfig,
  email: string,
): Promise<OmnigentApproval[]> {
  const response = await fetch(new URL("/v1/me/approvals/pending", config.baseUrl), {
    headers: omnigentHeaders(config, email),
  });
  await throwOnError(response, "list approvals", config.secrets);
  return ((await response.json()) as { approvals?: OmnigentApproval[] }).approvals ?? [];
}

/** `POST /v1/me/approvals/{id}/answer` — allow once, always allow (saves a rule) or deny. */
export async function answerOmnigentApproval(
  config: OmnigentClientConfig,
  email: string,
  id: string,
  decision: "once" | "always" | "deny",
): Promise<void> {
  const response = await fetch(
    new URL(`/v1/me/approvals/${encodeURIComponent(id)}/answer`, config.baseUrl),
    {
      method: "POST",
      headers: omnigentHeaders(config, email),
      body: JSON.stringify({ decision }),
    },
  );
  await throwOnError(response, "answer approval", config.secrets);
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
