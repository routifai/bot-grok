import type { OmnigentClientConfig } from "./client/core.js";
import { omnigentHeaders, throwOnError } from "./client/core.js";

/** An objective: an outcome pursued over time under one parent session
 * (engine/omnigent/docs/OBJECTIVES.md, routes/objectives.py `_to_response`). */
export interface OmnigentObjective {
  id: string;
  parent_session_id: string;
  title: string;
  description: string;
  status: "active" | "paused" | "done" | "archived";
  /** ISO-8601 date or datetime. */
  due: string | null;
  scheduled_task_id: string | null;
  created_at: number;
  updated_at: number | null;
  plan: OmnigentObjectiveTask[];
  open_proposal: OmnigentObjectiveProposal | null;
}

export interface OmnigentObjectiveTask {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "done" | "blocked" | "skipped";
  note: string | null;
}

export interface OmnigentObjectiveProposal {
  id: string;
  reason: string;
  /** The full proposed plan; `id` is set on an item that keeps an existing task. */
  plan: { id: string | null; title: string }[];
  status: "open" | "accepted" | "dismissed";
  created_at: number;
}

/** One Helper run of an objective, newest first; `result` is its final message's text. */
export interface OmnigentObjectiveLogEntry {
  run_id: string;
  status: string;
  scheduled_at: number;
  fired_at: number | null;
  finished_at: number | null;
  error_code: string | null;
  attempt: number;
  conversation_id: string | null;
  result: string | null;
}

function objectiveUrl(config: OmnigentClientConfig, id?: string, tail = ""): URL {
  const path = id ? `/v1/objectives/${encodeURIComponent(id)}${tail}` : "/v1/objectives";
  return new URL(path, config.baseUrl);
}

/** `GET /v1/objectives?parent_session_id=` — the objectives of one Super Chat. */
export async function listOmnigentObjectives(
  config: OmnigentClientConfig,
  email: string,
  parentSessionId: string,
): Promise<OmnigentObjective[]> {
  const url = objectiveUrl(config);
  url.searchParams.set("parent_session_id", parentSessionId);
  const response = await fetch(url, { headers: omnigentHeaders(config, email) });
  await throwOnError(response, "list objectives", config.secrets);
  const body = (await response.json()) as { objectives?: OmnigentObjective[] };
  return body.objectives ?? [];
}

export async function getOmnigentObjective(
  config: OmnigentClientConfig,
  email: string,
  id: string,
): Promise<OmnigentObjective> {
  const response = await fetch(objectiveUrl(config, id), {
    headers: omnigentHeaders(config, email),
  });
  await throwOnError(response, "get objective", config.secrets);
  return (await response.json()) as OmnigentObjective;
}

/** `PATCH /v1/objectives/{id}` — status moves keep the cadence task in step on the engine. */
export async function patchOmnigentObjective(
  config: OmnigentClientConfig,
  email: string,
  id: string,
  patch: { status?: OmnigentObjective["status"] },
): Promise<OmnigentObjective> {
  const response = await fetch(objectiveUrl(config, id), {
    method: "PATCH",
    headers: omnigentHeaders(config, email),
    body: JSON.stringify(patch),
  });
  await throwOnError(response, "update objective", config.secrets);
  return (await response.json()) as OmnigentObjective;
}

/** `POST /v1/objectives/{id}/proposals/{pid}/accept|dismiss` — returns the objective. A proposal
 * that is no longer open is an `OmnigentApiError` with code `conflict`. */
export async function decideOmnigentObjectiveProposal(
  config: OmnigentClientConfig,
  email: string,
  objectiveId: string,
  proposalId: string,
  decision: "accept" | "dismiss",
): Promise<OmnigentObjective> {
  const response = await fetch(
    objectiveUrl(config, objectiveId, `/proposals/${encodeURIComponent(proposalId)}/${decision}`),
    { method: "POST", headers: omnigentHeaders(config, email) },
  );
  await throwOnError(response, `${decision} objective proposal`, config.secrets);
  return (await response.json()) as OmnigentObjective;
}

/** `GET /v1/objectives/{id}/log` — the objective's Helper runs, newest first. */
export async function listOmnigentObjectiveLog(
  config: OmnigentClientConfig,
  email: string,
  id: string,
  limit = 50,
): Promise<OmnigentObjectiveLogEntry[]> {
  const url = objectiveUrl(config, id, "/log");
  url.searchParams.set("limit", String(limit));
  const response = await fetch(url, { headers: omnigentHeaders(config, email) });
  await throwOnError(response, "list objective log", config.secrets);
  const body = (await response.json()) as { log?: OmnigentObjectiveLogEntry[] };
  return body.log ?? [];
}
