import type { OmnigentClientConfig, OmnigentSessionResponse, OmnigentStreamEvent } from "./core.js";
import { omnigentHeaders, throwOnError } from "./core.js";

/** Where a session sits in a Super Chat family (ADR 0009), or `null` outside one. */
export interface OmnigentSessionSuperchat {
  kind: "super" | "side" | "helper" | null;
  /** The family's Super Chat. */
  root_id: string | null;
  /** A Side Chat's Super Chat, or a Helper's direct parent. */
  parent_id: string | null;
  seed_item_id: string | null;
  /** The Project the session has open (ADR 0008). */
  project: { slug: string; name: string } | null;
}

/** `GET /v1/sessions/{id}` — a cheap session snapshot (no items, liveness or usage). */
export interface OmnigentSessionSnapshot extends OmnigentSessionResponse {
  host_id?: string | null;
  labels?: Record<string, string>;
  superchat?: OmnigentSessionSuperchat | null;
}

export async function getOmnigentSession(
  config: OmnigentClientConfig,
  email: string,
  sessionId: string,
): Promise<OmnigentSessionSnapshot> {
  const url = new URL(`/v1/sessions/${encodeURIComponent(sessionId)}`, config.baseUrl);
  url.searchParams.set("include_items", "false");
  url.searchParams.set("include_liveness", "false");
  url.searchParams.set("include_usage", "false");
  const response = await fetch(url, { headers: omnigentHeaders(config, email) });
  await throwOnError(response, "get session", config.secrets);
  return (await response.json()) as OmnigentSessionSnapshot;
}

/** `POST /v1/sessions/{id}/events` with a `message` event carrying the user's turn text. */
export async function postOmnigentMessage(
  config: OmnigentClientConfig,
  email: string,
  sessionId: string,
  text: string,
): Promise<void> {
  const response = await fetch(
    new URL(`/v1/sessions/${encodeURIComponent(sessionId)}/events`, config.baseUrl),
    {
      method: "POST",
      headers: omnigentHeaders(config, email),
      body: JSON.stringify({
        type: "message",
        data: { role: "user", content: [{ type: "input_text", text }] },
      }),
    },
  );
  await throwOnError(response, "post message event", config.secrets);
}

/** `POST /v1/sessions/{id}/read` — the person has the chat open: moves their read baseline
 * (up to `itemId`, default now) and clears its unread flag. */
export async function markOmnigentRead(
  config: OmnigentClientConfig,
  email: string,
  sessionId: string,
  itemId?: string,
): Promise<void> {
  const response = await fetch(
    new URL(`/v1/sessions/${encodeURIComponent(sessionId)}/read`, config.baseUrl),
    {
      method: "POST",
      headers: omnigentHeaders(config, email),
      body: JSON.stringify(itemId ? { item_id: itemId } : {}),
    },
  );
  await throwOnError(response, "mark read", config.secrets);
}

/** `POST /v1/sessions/{id}/reset` — clears a Super Chat's Conversation. Owner only; the
 * engine answers 409 (`conflict`) while a turn is running. */
export async function resetOmnigentSession(
  config: OmnigentClientConfig,
  email: string,
  sessionId: string,
): Promise<{ session_id: string; reset_item_id: string | null; created_at: number | null }> {
  const response = await fetch(
    new URL(`/v1/sessions/${encodeURIComponent(sessionId)}/reset`, config.baseUrl),
    { method: "POST", headers: omnigentHeaders(config, email) },
  );
  await throwOnError(response, "reset session", config.secrets);
  return (await response.json()) as {
    session_id: string;
    reset_item_id: string | null;
    created_at: number | null;
  };
}

export interface OmnigentPaginatedList<T> {
  data: T[];
  first_id?: string | null;
  last_id?: string | null;
  has_more?: boolean;
}

/**
 * `GET /v1/sessions/{id}/stream` — live SSE tail. Yields each parsed `data:` frame (skipping
 * the `[DONE]` sentinel and unparsable keepalive lines) until the response body ends or
 * `signal` aborts. Buffering/parsing mirrors apps/mobile/lib/api.ts's `subscribeThread`.
 */
export function streamOmnigentSession(
  config: OmnigentClientConfig,
  email: string,
  sessionId: string,
  signal?: AbortSignal,
): AsyncGenerator<OmnigentStreamEvent> {
  return streamOmnigentSse(config, email, `/v1/sessions/${encodeURIComponent(sessionId)}/stream`, {
    signal,
    what: "stream session",
  });
}

/** Any Omnigent SSE endpoint: yields each parsed `data:` frame (see `streamOmnigentSession`). */
export async function* streamOmnigentSse(
  config: OmnigentClientConfig,
  email: string,
  path: string,
  options: { signal?: AbortSignal; what: string },
): AsyncGenerator<OmnigentStreamEvent> {
  const response = await fetch(new URL(path, config.baseUrl), {
    headers: { ...omnigentHeaders(config, email), accept: "text/event-stream" },
    signal: options.signal,
  });
  await throwOnError(response, options.what, config.secrets);
  if (!response.body) return;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";
      for (const chunk of chunks) {
        const data = chunk
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("");
        if (!data || data === "[DONE]") continue;
        try {
          const parsed = JSON.parse(data) as OmnigentStreamEvent;
          if (parsed?.type) yield parsed;
        } catch {
          // Ignore keepalives and partial frames, same as the mobile client.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
