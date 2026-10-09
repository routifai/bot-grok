import type { OmnigentClientConfig } from "./client/core.js";
import { omnigentHeaders, throwOnError } from "./client/core.js";

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

/** One decision waiting on the person (`GET /v1/me/asks`). Wording is the client's: `kind` and
 * the choice ids are stable codes. */
export type OmnigentAsk =
  | (OmnigentAskBase & {
      kind: "approval";
      subject: {
        summary: string;
        can_always: boolean;
        always_label: string | null;
        [key: string]: unknown;
      };
    })
  | (OmnigentAskBase & {
      kind: "plan_proposal";
      subject: {
        objective_title: string;
        reason: string;
        is_first_plan: boolean;
        plan: Array<{ id: string | null; title: string }>;
      };
    })
  | (OmnigentAskBase & {
      kind: "blocked_task";
      subject: { objective_title: string; task_id: string; title: string; note: string | null };
    });

interface OmnigentAskBase {
  /** `approval:<id>`, `proposal:<objective>:<id>` or `task:<objective>:<id>`. */
  id: string;
  session_id: string;
  objective_id: string | null;
  /** Epoch seconds. */
  created_at: number;
  choices: Array<{ id: string; style: "primary" | "secondary" | "danger" }>;
}

/** `GET /v1/me/asks` — everything waiting on the caller, newest first. */
export async function listOmnigentAsks(
  config: OmnigentClientConfig,
  email: string,
): Promise<OmnigentAsk[]> {
  const response = await fetch(new URL("/v1/me/asks", config.baseUrl), {
    headers: omnigentHeaders(config, email),
  });
  await throwOnError(response, "list asks", config.secrets);
  return ((await response.json()) as { data: OmnigentAsk[] }).data;
}

/** `POST /v1/me/asks/{id}/answer` — `choice` is one of the ask's choice ids; a blocked task's
 * `answer` needs the person's reply as `note`. */
export async function answerOmnigentAsk(
  config: OmnigentClientConfig,
  email: string,
  askId: string,
  answer: { choice: string; note?: string },
): Promise<void> {
  const response = await fetch(
    new URL(`/v1/me/asks/${encodeURIComponent(askId)}/answer`, config.baseUrl),
    {
      method: "POST",
      headers: omnigentHeaders(config, email),
      body: JSON.stringify(answer),
    },
  );
  await throwOnError(response, "answer ask", config.secrets);
}
