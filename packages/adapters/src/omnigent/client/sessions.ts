import type { OmnigentClientConfig, OmnigentSessionResponse, OmnigentStreamEvent } from "./core.js";
import { omnigentHeaders, throwOnError } from "./core.js";

/**
 * `POST /v1/sessions` from an existing (built-in) agent id, with session labels.
 *
 * Runner-location binding (docs/omnigent-spike.md "Nova computer" launcher; schema at
 * engine/omnigent/omnigent/server/schemas.py `_SessionCreateRequestBase`): omit every `host*`
 * field for the pre-existing external/caller-managed behavior, or set exactly one of —
 * - `hostType: "managed"` (+ optional `sandboxProvider`) so Omnigent provisions and binds the
 *   host itself (the "computer" runner location); `hostId`/`workspace` must stay unset.
 * - `hostId` + `workspace` (an absolute path on that host) to bind an already-connected host
 *   directly (the "local" runner location).
 */
export async function createOmnigentSession(
  config: OmnigentClientConfig,
  email: string,
  input: {
    agentId: string;
    labels: Record<string, string>;
    title?: string;
    hostType?: "managed" | "external";
    sandboxProvider?: string;
    hostId?: string;
    workspace?: string;
  },
): Promise<OmnigentSessionResponse> {
  const response = await fetch(new URL("/v1/sessions", config.baseUrl), {
    method: "POST",
    headers: omnigentHeaders(config, email),
    body: JSON.stringify({
      agent_id: input.agentId,
      labels: input.labels,
      title: input.title,
      ...(input.hostType ? { host_type: input.hostType } : {}),
      ...(input.sandboxProvider ? { sandbox_provider: input.sandboxProvider } : {}),
      ...(input.hostId ? { host_id: input.hostId } : {}),
      ...(input.workspace ? { workspace: input.workspace } : {}),
    }),
  });
  await throwOnError(response, "create session", config.secrets);
  return (await response.json()) as OmnigentSessionResponse;
}

/**
 * `GET /v1/sessions/{id}` — a cheap session snapshot (no items/liveness/usage), used by
 * ./gateway.ts to check whether a reused session ever got a runner bound (`host_id`). A pre-fix
 * session created with no `host_type` binds no host at all and stays that way forever — see
 * ensureOmnigentSession's repair path.
 */
export interface OmnigentSessionSnapshot extends OmnigentSessionResponse {
  host_id?: string | null;
  /** Helper (sub-agent) / Side Chat ancestry: null for a Super Chat (superside-chat.md). */
  parent_session_id?: string | null;
  /** Session labels, including `omnigent.context.mode` (superside-chat.md). Used by
   * ./gateway.ts to detect a Super Chat created before the mode label existed. */
  labels?: Record<string, string>;
  /** The session's working directory on its host; moves when the Muse opens a Project. */
  workspace?: string | null;
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

/** `GET /v1/agents` — resolves a built-in agent's durable id by its bundle name. */
export async function findOmnigentAgentIdByName(
  config: OmnigentClientConfig,
  email: string,
  name: string,
): Promise<string | undefined> {
  const url = new URL("/v1/agents", config.baseUrl);
  url.searchParams.set("limit", "100");
  const response = await fetch(url, { headers: omnigentHeaders(config, email) });
  await throwOnError(response, "list agents", config.secrets);
  const body = (await response.json()) as { data?: Array<{ id: string; name: string }> };
  return body.data?.find((agent) => agent.name === name)?.id;
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

/**
 * `POST /v1/sessions/{id}/switch-agent` — rebinds an existing session in place to a different
 * built-in agent bundle (engine/omnigent/omnigent/server/routes/sessions/routes_core.py
 * ~3580-3700, request body `SessionSwitchAgentRequest` in
 * engine/omnigent/omnigent/server/schemas.py:2683-2697). Only works while the session is idle
 * and only for a built-in (not session-scoped) target agent id.
 */
export async function switchOmnigentAgent(
  config: OmnigentClientConfig,
  email: string,
  sessionId: string,
  agentId: string,
): Promise<OmnigentSessionResponse> {
  const response = await fetch(
    new URL(`/v1/sessions/${encodeURIComponent(sessionId)}/switch-agent`, config.baseUrl),
    {
      method: "POST",
      headers: omnigentHeaders(config, email),
      body: JSON.stringify({ agent_id: agentId }),
    },
  );
  await throwOnError(response, "switch agent", config.secrets);
  return (await response.json()) as OmnigentSessionResponse;
}

export interface OmnigentPaginatedList<T> {
  data: T[];
  first_id?: string | null;
  last_id?: string | null;
  has_more?: boolean;
}

export type OmnigentSessionItem = Record<string, unknown> & {
  id: string;
  type: string;
  role?: string;
  content?: unknown;
  created_at?: number;
  /** Set by the engine on a message it wrote itself (a wake notice, a timer firing). */
  is_system_notice?: boolean;
};

/** `GET /v1/sessions/{id}/items` — the committed conversation transcript, cursor-paginated
 * (engine/omnigent/omnigent/server/routes/sessions/routes_items.py). Used both for a chat's
 * message history (apps/api/src/chats.ts) and the mirror job's scan for items the Super Chat
 * produced on its own (./mirror.ts). */
export async function listOmnigentSessionItems(
  config: OmnigentClientConfig,
  email: string,
  sessionId: string,
  options: { limit?: number; after?: string; before?: string; order?: "asc" | "desc" } = {},
): Promise<OmnigentPaginatedList<OmnigentSessionItem>> {
  const url = new URL(`/v1/sessions/${encodeURIComponent(sessionId)}/items`, config.baseUrl);
  if (options.limit !== undefined) url.searchParams.set("limit", String(options.limit));
  if (options.after) url.searchParams.set("after", options.after);
  if (options.before) url.searchParams.set("before", options.before);
  if (options.order) url.searchParams.set("order", options.order);
  const response = await fetch(url, { headers: omnigentHeaders(config, email) });
  await throwOnError(response, "list session items", config.secrets);
  return (await response.json()) as OmnigentPaginatedList<OmnigentSessionItem>;
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
