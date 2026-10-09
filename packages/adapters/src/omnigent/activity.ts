import type { OmnigentClientConfig } from "./core.js";
import { omnigentHeaders, throwOnError } from "./core.js";
import { type OmnigentPaginatedList, streamOmnigentSse } from "./sessions.js";

export interface OmnigentActivityStep {
  item_id: string;
  title: string;
  created_at: number;
  tool?: string | null;
  detail?: Record<string, unknown> | null;
}

export interface OmnigentActivity {
  id: string;
  kind: "turn" | "sub_agent";
  source: "turn" | "side_chat" | "background" | "housekeeping" | "scheduled" | "goal";
  chat_id: string;
  title: string;
  outcome: string | null;
  summary: string | null;
  status: "in_progress" | "done" | "failed" | "cancelled";
  started_at: number;
  finished_at: number | null;
  date: string;
  steps?: OmnigentActivityStep[];
  parent_chat_id?: string | null;
}

/** `GET /v1/sessions/{superId}/activities?before=&limit=` — the Activity Feed, newest first
 * (superside-chat.md). */
export async function listOmnigentActivities(
  config: OmnigentClientConfig,
  email: string,
  superSessionId: string,
  options: { before?: number; limit?: number; tz?: string } = {},
): Promise<OmnigentPaginatedList<OmnigentActivity>> {
  const url = new URL(
    `/v1/sessions/${encodeURIComponent(superSessionId)}/activities`,
    config.baseUrl,
  );
  if (options.before !== undefined) url.searchParams.set("before", String(options.before));
  if (options.limit !== undefined) url.searchParams.set("limit", String(options.limit));
  if (options.tz) url.searchParams.set("tz", options.tz);
  const response = await fetch(url, { headers: omnigentHeaders(config, email) });
  await throwOnError(response, "list activities", config.secrets);
  return (await response.json()) as OmnigentPaginatedList<OmnigentActivity>;
}

/** `GET /v1/sessions/{superId}/activities/{activityId}` — one Activity with full step detail. */
export async function getOmnigentActivity(
  config: OmnigentClientConfig,
  email: string,
  superSessionId: string,
  activityId: string,
  options: { tz?: string } = {},
): Promise<OmnigentActivity> {
  const url = new URL(
    `/v1/sessions/${encodeURIComponent(superSessionId)}/activities/${encodeURIComponent(activityId)}`,
    config.baseUrl,
  );
  if (options.tz) url.searchParams.set("tz", options.tz);
  const response = await fetch(url, { headers: omnigentHeaders(config, email) });
  await throwOnError(response, "get activity", config.secrets);
  return (await response.json()) as OmnigentActivity;
}

/** `GET /v1/sessions/{superId}/activities/stream` — a frame on connect and one each time the
 * family's Activity Feed may have changed (a Helper started, stepped, settled). No content: the
 * caller re-reads the feed. Ends when the response ends or `signal` aborts. */
export function streamOmnigentActivityChanges(
  config: OmnigentClientConfig,
  email: string,
  superSessionId: string,
  signal?: AbortSignal,
) {
  return streamOmnigentSse(
    config,
    email,
    `/v1/sessions/${encodeURIComponent(superSessionId)}/activities/stream`,
    { signal, what: "watch activities" },
  );
}
