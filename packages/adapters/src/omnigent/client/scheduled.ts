import type { OmnigentClientConfig } from "./core.js";
import { omnigentHeaders, throwOnError } from "./core.js";

/** A scheduled task (engine/omnigent/omnigent/server/routes/scheduled_tasks.py `_to_response`);
 * `parent_session_id` and `agent_type` tie a followed topic to its Muse's Super Chat. */
export interface OmnigentScheduledTask {
  id: string;
  name: string;
  prompt: string;
  rrule: string;
  timezone: string;
  state: "active" | "paused" | string;
  parent_session_id?: string | null;
  agent_type?: string | null;
  created_at?: number;
  last_run_at?: number | null;
  next_run_at?: string | null;
}

export interface OmnigentScheduledTaskRun {
  id: string;
  scheduled_task_id: string;
  status: "scheduled" | "running" | "succeeded" | "failed" | "skipped" | string;
  scheduled_at: number;
  /** The run's session: its final assistant message is the run's Result. */
  conversation_id: string | null;
  fired_at: number | null;
  finished_at: number | null;
}

function scheduledTaskUrl(config: OmnigentClientConfig, id?: string, tail = ""): URL {
  const path = id ? `/v1/scheduled-tasks/${encodeURIComponent(id)}${tail}` : "/v1/scheduled-tasks";
  return new URL(path, config.baseUrl);
}

/** `GET /v1/scheduled-tasks?parent_session_id=` — the tasks parented on one Super Chat. */
export async function listOmnigentScheduledTasks(
  config: OmnigentClientConfig,
  email: string,
  parentSessionId: string,
): Promise<OmnigentScheduledTask[]> {
  const url = scheduledTaskUrl(config);
  url.searchParams.set("parent_session_id", parentSessionId);
  const response = await fetch(url, { headers: omnigentHeaders(config, email) });
  await throwOnError(response, "list scheduled tasks", config.secrets);
  const body = (await response.json()) as { scheduled_tasks?: OmnigentScheduledTask[] };
  return body.scheduled_tasks ?? [];
}

export async function getOmnigentScheduledTask(
  config: OmnigentClientConfig,
  email: string,
  id: string,
): Promise<OmnigentScheduledTask> {
  const response = await fetch(scheduledTaskUrl(config, id), {
    headers: omnigentHeaders(config, email),
  });
  await throwOnError(response, "get scheduled task", config.secrets);
  return (await response.json()) as OmnigentScheduledTask;
}

/** `GET /v1/scheduled-tasks/{id}/runs` — newest first. */
export async function listOmnigentScheduledTaskRuns(
  config: OmnigentClientConfig,
  email: string,
  id: string,
  limit = 5,
): Promise<OmnigentScheduledTaskRun[]> {
  const url = scheduledTaskUrl(config, id, "/runs");
  url.searchParams.set("limit", String(limit));
  const response = await fetch(url, { headers: omnigentHeaders(config, email) });
  await throwOnError(response, "list scheduled task runs", config.secrets);
  const body = (await response.json()) as { runs?: OmnigentScheduledTaskRun[] };
  return body.runs ?? [];
}

export async function createOmnigentScheduledTask(
  config: OmnigentClientConfig,
  email: string,
  input: {
    name: string;
    prompt: string;
    rrule: string;
    parentSessionId: string;
    agentType: string;
    timezone?: string;
  },
): Promise<OmnigentScheduledTask> {
  const response = await fetch(scheduledTaskUrl(config), {
    method: "POST",
    headers: omnigentHeaders(config, email),
    body: JSON.stringify({
      name: input.name,
      prompt: input.prompt,
      rrule: input.rrule,
      parent_session_id: input.parentSessionId,
      agent_type: input.agentType,
      ...(input.timezone ? { timezone: input.timezone } : {}),
    }),
  });
  await throwOnError(response, "create scheduled task", config.secrets);
  return (await response.json()) as OmnigentScheduledTask;
}

/** `PATCH /v1/scheduled-tasks/{id}` — pause (`"paused"`) or resume (`"active"`), or change the
 * schedule (`rrule`). */
export async function patchOmnigentScheduledTask(
  config: OmnigentClientConfig,
  email: string,
  id: string,
  patch: { state?: "active" | "paused"; rrule?: string },
): Promise<OmnigentScheduledTask> {
  const response = await fetch(scheduledTaskUrl(config, id), {
    method: "PATCH",
    headers: omnigentHeaders(config, email),
    body: JSON.stringify(patch),
  });
  await throwOnError(response, "update scheduled task", config.secrets);
  return (await response.json()) as OmnigentScheduledTask;
}

/** `POST /v1/scheduled-tasks/{id}/run` — fire now (202, fire-and-forget). */
export async function runOmnigentScheduledTask(
  config: OmnigentClientConfig,
  email: string,
  id: string,
): Promise<void> {
  const response = await fetch(scheduledTaskUrl(config, id, "/run"), {
    method: "POST",
    headers: omnigentHeaders(config, email),
  });
  await throwOnError(response, "run scheduled task", config.secrets);
}

export async function deleteOmnigentScheduledTask(
  config: OmnigentClientConfig,
  email: string,
  id: string,
): Promise<void> {
  const response = await fetch(scheduledTaskUrl(config, id), {
    method: "DELETE",
    headers: omnigentHeaders(config, email),
  });
  await throwOnError(response, "delete scheduled task", config.secrets);
}
