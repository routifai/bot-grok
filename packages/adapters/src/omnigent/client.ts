// Minimal typed client for the Omnigent REST API (engine/omnigent/omnigent/server/API.md,
// engine/omnigent/openapi.json), used by ./gateway.ts to run a Nova turn on Omnigent
// (NOVA_ENGINE=omnigent, docs/omnigent-spike.md). Every call carries the identity/proxy
// headers Omnigent's header auth mode expects — no SDK dependency, just fetch and a tiny
// SSE line parser mirroring apps/mobile/lib/api.ts's `subscribeThread`.
import { redactSecrets } from "@aiden/core";

export interface OmnigentClientConfig {
  /** Base URL of the Omnigent server, e.g. "http://127.0.0.1:8000". */
  baseUrl: string;
  /** Shared secret Omnigent's header-auth proxy mode expects on every request. */
  proxySecret: string;
  /** Secret values redacted out of an Omnigent error body before it reaches a thrown Error's
   * message (./env.ts's `omnigentRedactionSecretsFromEnv` — the same list ./gateway.ts and
   * ./mirror.ts redact a reply with). `undefined` (not just empty) means "no list was wired
   * up here" — `throwOnError` then drops the body entirely rather than risking an unredacted
   * leak. */
  secrets?: string[];
}

export interface OmnigentSessionResponse {
  id: string;
  status: string;
  agent_id?: string;
  [key: string]: unknown;
}

export interface OmnigentStreamEvent {
  type: string;
  [key: string]: unknown;
}

function omnigentHeaders(config: OmnigentClientConfig, email: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "X-Forwarded-Email": email,
    "X-Omnigent-Proxy-Secret": config.proxySecret,
  };
}

/** An Omnigent error response's `error.code` (e.g. `"stale_cursor"`,
 * engine/omnigent/omnigent/server/routes/_errors.py `STALE_CURSOR_RESPONSE`), when the body
 * parses as the documented `{error: {code, message}}` shape. */
export class OmnigentApiError extends Error {
  code: string | undefined;
  constructor(message: string, code: string | undefined) {
    super(message);
    this.name = "OmnigentApiError";
    this.code = code;
  }
}

function errorCodeFromBody(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as { error?: { code?: unknown } };
    return typeof parsed.error?.code === "string" ? parsed.error.code : undefined;
  } catch {
    return undefined;
  }
}

/** True for `OmnigentApiError`s whose `error.code` is `"stale_cursor"` — the cursor passed to a
 * paginated list route (e.g. `GET .../items`) names an item that no longer exists, so
 * enumeration cannot continue from it (engine/omnigent/omnigent/server/routes/_errors.py).
 * Callers that keep a persisted cursor (./mirror.ts) reset it to start over on the next page
 * rather than treating this as a generic failure. */
export function isStaleCursorError(error: unknown): boolean {
  return error instanceof OmnigentApiError && error.code === "stale_cursor";
}

/** The engine no longer has the session (deleted, or a different engine database). */
export function isSessionNotFoundError(error: unknown): boolean {
  return error instanceof OmnigentApiError && error.code === "not_found";
}

/**
 * Throws `OmnigentApiError` on a non-2xx response. The body is redacted with `secrets` before
 * it reaches the thrown message (item 5, docs/super-chat/WIRING.md review); when `secrets` is
 * `undefined` (not just empty — a caller that never wired up the list at all) the body is
 * dropped rather than risking an unredacted leak into a log or an API error message.
 */
async function throwOnError(
  response: Response,
  what: string,
  secrets?: string[],
): Promise<Response> {
  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    const code = errorCodeFromBody(raw);
    const body = secrets ? redactSecrets(raw, secrets).slice(0, 500) : "";
    throw new OmnigentApiError(`omnigent ${what} failed (${response.status}): ${body}`, code);
  }
  return response;
}

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

export interface OmnigentHostSummary {
  host_id: string;
  name: string;
  owner: string;
  status: "online" | "offline";
  /** Non-null marks a server-managed sandbox host — never a "local" runner-location target. */
  sandbox_provider: string | null;
  [key: string]: unknown;
}

/** `GET /v1/hosts` — every host owned by `email`, used to find their connected `omnigent host`
 * for the "local" runner location. */
export async function listOmnigentHosts(
  config: OmnigentClientConfig,
  email: string,
): Promise<OmnigentHostSummary[]> {
  const response = await fetch(new URL("/v1/hosts", config.baseUrl), {
    headers: omnigentHeaders(config, email),
  });
  await throwOnError(response, "list hosts", config.secrets);
  const body = (await response.json()) as { hosts?: OmnigentHostSummary[] };
  return body.hosts ?? [];
}

export interface OmnigentHostDirEntry {
  name: string;
  path: string;
  type: "directory" | "file" | "other";
}

/** `GET /v1/hosts/{id}/filesystem/{path}` — list a directory's entries (absolute paths). */
export async function listOmnigentHostDirectory(
  config: OmnigentClientConfig,
  email: string,
  hostId: string,
  path: string,
): Promise<OmnigentHostDirEntry[]> {
  const response = await fetch(
    new URL(`/v1/hosts/${encodeURIComponent(hostId)}/filesystem/${path}`, config.baseUrl),
    { headers: omnigentHeaders(config, email) },
  );
  await throwOnError(response, "list host directory", config.secrets);
  const body = (await response.json()) as { data?: OmnigentHostDirEntry[] };
  return body.data ?? [];
}

/** `POST /v1/hosts/{id}/directories` — create (idempotent from the caller's view via
 * ./gateway.ts's fallback) the absolute workspace directory a "local" session starts in. */
export async function createOmnigentHostDirectory(
  config: OmnigentClientConfig,
  email: string,
  hostId: string,
  path: string,
): Promise<{ path: string }> {
  const response = await fetch(
    new URL(`/v1/hosts/${encodeURIComponent(hostId)}/directories`, config.baseUrl),
    {
      method: "POST",
      headers: omnigentHeaders(config, email),
      body: JSON.stringify({ path }),
    },
  );
  await throwOnError(response, "create host directory", config.secrets);
  return (await response.json()) as { path: string };
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

export interface OmnigentSideChatCreateResponse {
  conversation_id: string;
  title: string | null;
  start: "with_context" | "blank";
  /** Set by the engine (docs/super-chat/WIRING.md slice A1 review) when the Side Chat itself
   * was created but its seed first message could not be posted — the chat still exists;
   * `apps/api/src/chats.ts#createSideChat` retries the post once. */
  first_message_error?: string | null;
}

/** Thrown by `createOmnigentSideChat` on a non-2xx response. `conversationId` is set when the
 * (redacted-before-reaching-here) error body still names a `conversation_id` — i.e. the Side
 * Chat was created despite the error — so the caller can tell "nothing happened" apart from
 * "it exists, but something about it (its first message) failed". */
export class OmnigentSideChatError extends Error {
  conversationId: string | null;
  constructor(message: string, conversationId: string | null) {
    super(message);
    this.name = "OmnigentSideChatError";
    this.conversationId = conversationId;
  }
}

function conversationIdFromBody(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { conversation_id?: unknown };
    return typeof parsed.conversation_id === "string" ? parsed.conversation_id : null;
  } catch {
    return null;
  }
}

/** `POST /v1/sessions/{superId}/side_chats` (docs/super-chat/WIRING.md slice E1): creates a
 * Side Chat of the Super Chat `superId`, optionally seeded with its first message. Diverges
 * from the generic `throwOnError` path on a non-2xx response (see `OmnigentSideChatError`)
 * because a Side Chat can exist even when this call reports an error. */
export async function createOmnigentSideChat(
  config: OmnigentClientConfig,
  email: string,
  superSessionId: string,
  input: { start: "with_context" | "blank"; title?: string; firstMessage?: string },
): Promise<OmnigentSideChatCreateResponse> {
  const response = await fetch(
    new URL(`/v1/sessions/${encodeURIComponent(superSessionId)}/side_chats`, config.baseUrl),
    {
      method: "POST",
      headers: omnigentHeaders(config, email),
      body: JSON.stringify({
        start: input.start,
        ...(input.title ? { title: input.title } : {}),
        ...(input.firstMessage ? { first_message: input.firstMessage } : {}),
      }),
    },
  );
  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    const conversationId = conversationIdFromBody(raw);
    const body = config.secrets ? redactSecrets(raw, config.secrets).slice(0, 500) : "";
    throw new OmnigentSideChatError(
      `omnigent create side chat failed (${response.status}): ${body}`,
      conversationId,
    );
  }
  return (await response.json()) as OmnigentSideChatCreateResponse;
}

export interface OmnigentRelatedChat {
  id: string;
  title: string | null;
  created_at: number;
  updated_at: number;
  last_message_preview: string | null;
  archived?: boolean;
  start?: "with_context" | "blank" | null;
  summary?: string | null;
  live?: boolean;
}

/** `GET /v1/sessions/{superId}/related_chats` — the Super Chat's Side Chats (not cursor-
 * paginated; superside-chat.md). */
export async function listOmnigentRelatedChats(
  config: OmnigentClientConfig,
  email: string,
  superSessionId: string,
): Promise<OmnigentPaginatedList<OmnigentRelatedChat>> {
  const response = await fetch(
    new URL(`/v1/sessions/${encodeURIComponent(superSessionId)}/related_chats`, config.baseUrl),
    { headers: omnigentHeaders(config, email) },
  );
  await throwOnError(response, "list related chats", config.secrets);
  return (await response.json()) as OmnigentPaginatedList<OmnigentRelatedChat>;
}

/** `GET /v1/sessions/{id}/context_summary` — the summary a new "Knows our conversation" Side
 * Chat would start with. */
export async function getOmnigentContextSummary(
  config: OmnigentClientConfig,
  email: string,
  sessionId: string,
): Promise<{ summary: string | null; created_at: number | null }> {
  const response = await fetch(
    new URL(`/v1/sessions/${encodeURIComponent(sessionId)}/context_summary`, config.baseUrl),
    { headers: omnigentHeaders(config, email) },
  );
  await throwOnError(response, "get context summary", config.secrets);
  return (await response.json()) as { summary: string | null; created_at: number | null };
}

export async function getOmnigentMemoryProfile(
  config: OmnigentClientConfig,
  email: string,
  sessionId: string,
): Promise<{ profile: string | null }> {
  const response = await fetch(
    new URL(`/v1/sessions/${encodeURIComponent(sessionId)}/memory/profile`, config.baseUrl),
    { headers: omnigentHeaders(config, email) },
  );
  await throwOnError(response, "get memory profile", config.secrets);
  const body = (await response.json()) as { profile?: string | null };
  return { profile: body.profile || null };
}

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
  chat_id: string;
  title: string;
  outcome: string | null;
  status: "in_progress" | "done" | "failed" | "cancelled";
  started_at: number;
  finished_at: number | null;
  date: string;
  steps?: OmnigentActivityStep[];
}

/** `GET /v1/sessions/{superId}/activities?before=&limit=` — the Activity Feed, newest first
 * (superside-chat.md). */
export async function listOmnigentActivities(
  config: OmnigentClientConfig,
  email: string,
  superSessionId: string,
  options: { before?: number; limit?: number } = {},
): Promise<OmnigentPaginatedList<OmnigentActivity>> {
  const url = new URL(
    `/v1/sessions/${encodeURIComponent(superSessionId)}/activities`,
    config.baseUrl,
  );
  if (options.before !== undefined) url.searchParams.set("before", String(options.before));
  if (options.limit !== undefined) url.searchParams.set("limit", String(options.limit));
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
): Promise<OmnigentActivity> {
  const response = await fetch(
    new URL(
      `/v1/sessions/${encodeURIComponent(superSessionId)}/activities/${encodeURIComponent(activityId)}`,
      config.baseUrl,
    ),
    { headers: omnigentHeaders(config, email) },
  );
  await throwOnError(response, "get activity", config.secrets);
  return (await response.json()) as OmnigentActivity;
}

/**
 * `GET /v1/sessions/{id}/stream` — live SSE tail. Yields each parsed `data:` frame (skipping
 * the `[DONE]` sentinel and unparsable keepalive lines) until the response body ends or
 * `signal` aborts. Buffering/parsing mirrors apps/mobile/lib/api.ts's `subscribeThread`.
 */
export async function* streamOmnigentSession(
  config: OmnigentClientConfig,
  email: string,
  sessionId: string,
  signal?: AbortSignal,
): AsyncGenerator<OmnigentStreamEvent> {
  const response = await fetch(
    new URL(`/v1/sessions/${encodeURIComponent(sessionId)}/stream`, config.baseUrl),
    { headers: { ...omnigentHeaders(config, email), accept: "text/event-stream" }, signal },
  );
  await throwOnError(response, "stream session", config.secrets);
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
