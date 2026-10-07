import type { OmnigentClientConfig } from "./core.js";
import { omnigentHeaders, throwOnError } from "./core.js";
import { streamOmnigentSse } from "./sessions.js";

/** One block of a transcript message (engine/omnigent/omnigent/superchat/transcript/blocks.py). */
export type OmnigentTranscriptBlock =
  | { type: "text"; text: string }
  | {
      type: "card";
      card_id?: string | null;
      card: {
        card: string;
        id?: string;
        title?: string;
        data: Record<string, unknown>;
        fallback: string;
      };
      pending?: boolean;
    }
  | { type: "helper"; call_id: string; session_id: string; title: string; status: string }
  | {
      type: "file";
      artifact_id: string;
      name: string;
      mime: string | null;
      kind?: string;
      size?: number;
      title?: string;
      version?: number;
      versions?: number;
    }
  | { type: "secure_entry"; request_id: string; name: string; site: string; reason?: string }
  | { type: "error"; code: string; level?: "info" };

export interface OmnigentTranscriptMessage {
  id: string;
  role: "user" | "assistant";
  created_at: number | null;
  blocks: OmnigentTranscriptBlock[];
}

export interface OmnigentTranscriptLineage {
  kind: "super" | "side" | "helper" | null;
  root_id: string | null;
  parent_id: string | null;
  seed_item_id: string | null;
}

export interface OmnigentTranscriptPage {
  data: OmnigentTranscriptMessage[];
  has_more: boolean;
  older_cursor: string | null;
  lineage: OmnigentTranscriptLineage;
}

/** `GET /v1/sessions/{id}/transcript` — a session's messages as typed blocks, oldest first.
 * `before` is a previous page's `older_cursor`. */
export async function getOmnigentTranscript(
  config: OmnigentClientConfig,
  email: string,
  sessionId: string,
  options: { limit?: number; before?: string; includeSeed?: boolean } = {},
): Promise<OmnigentTranscriptPage> {
  const url = new URL(`/v1/sessions/${encodeURIComponent(sessionId)}/transcript`, config.baseUrl);
  if (options.limit !== undefined) url.searchParams.set("limit", String(options.limit));
  if (options.before) url.searchParams.set("before", options.before);
  if (options.includeSeed) url.searchParams.set("include_seed", "true");
  const response = await fetch(url, { headers: omnigentHeaders(config, email) });
  await throwOnError(response, "get transcript", config.secrets);
  return (await response.json()) as OmnigentTranscriptPage;
}

/** A frame of the family stream. Ids only; the caller refetches what changed. */
export type OmnigentFamilyEvent =
  | { type: "message.done"; chat_id: string; item_id: string }
  | { type: "turn.done"; chat_id: string; status: string }
  | { type: "chats.changed"; root_id: string }
  | { type: "activities.changed"; root_id: string }
  | { type: "session.heartbeat" };

/** `GET /v1/sessions/{root}/family/stream` — one SSE stream for a Conversation, its Side Chats
 * and its Helpers. Ends when the response ends or `signal` aborts. */
export async function* streamOmnigentFamily(
  config: OmnigentClientConfig,
  email: string,
  rootSessionId: string,
  signal?: AbortSignal,
): AsyncGenerator<OmnigentFamilyEvent> {
  for await (const frame of streamOmnigentSse(
    config,
    email,
    `/v1/sessions/${encodeURIComponent(rootSessionId)}/family/stream`,
    { signal, what: "watch family" },
  )) {
    if (
      frame.type === "message.done" ||
      frame.type === "turn.done" ||
      frame.type === "chats.changed" ||
      frame.type === "activities.changed" ||
      frame.type === "session.heartbeat"
    ) {
      yield frame as unknown as OmnigentFamilyEvent;
    }
  }
}

/** A message the engine's search found: its id is the transcript message's id. */
export interface OmnigentSearchHit {
  id: string;
  role: "user" | "assistant";
  text: string;
}

/** `GET /v1/sessions/{id}/items/search` — full-text search over one session's own items,
 * ranked, at most 20. Only the person's and the Muse's messages are returned (tool calls and
 * outputs are the engine's plumbing). */
export async function searchOmnigentMessages(
  config: OmnigentClientConfig,
  email: string,
  sessionId: string,
  query: string,
  limit = 10,
): Promise<OmnigentSearchHit[]> {
  const url = new URL(`/v1/sessions/${encodeURIComponent(sessionId)}/items/search`, config.baseUrl);
  url.searchParams.set("query", query);
  url.searchParams.set("limit", String(Math.min(limit, 20)));
  const response = await fetch(url, { headers: omnigentHeaders(config, email) });
  await throwOnError(response, "search session", config.secrets);
  const body = (await response.json()) as { data?: Array<Record<string, unknown>> };
  const hits: OmnigentSearchHit[] = [];
  for (const item of body.data ?? []) {
    if (item.type !== "message" || (item.role !== "user" && item.role !== "assistant")) continue;
    if (typeof item.id !== "string" || !Array.isArray(item.content)) continue;
    const text = item.content
      .map((part: unknown) =>
        part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : "",
      )
      .filter(Boolean)
      .join("\n\n")
      .trim();
    if (text) hits.push({ id: item.id, role: item.role, text });
  }
  return hits;
}
