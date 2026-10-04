// Minimal typed client for the Omnigent REST API (engine/omnigent/omnigent/server/API.md,
// engine/omnigent/openapi.json), used by ./gateway.ts to run a Nova turn on Omnigent
// (docs/omnigent-spike.md). Every call carries the identity/proxy
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

export interface OmnigentComputerState {
  available: boolean;
  in_control: boolean;
}

export interface OmnigentComputerScreen {
  /** The supervisor's noVNC URL incl. token — reachable from Nova's API host, not the browser. */
  screen_url: string;
  in_control: boolean;
}

function computerUrl(config: OmnigentClientConfig, sessionId: string, tail = ""): URL {
  return new URL(`/v1/sessions/${encodeURIComponent(sessionId)}/computer${tail}`, config.baseUrl);
}

/** `GET /v1/sessions/{id}/computer` — whether the session has a Computer and who controls it
 * (engine/omnigent/omnigent/server/routes/sessions/routes_computer.py). */
export async function getOmnigentComputer(
  config: OmnigentClientConfig,
  email: string,
  sessionId: string,
): Promise<OmnigentComputerState> {
  const response = await fetch(computerUrl(config, sessionId), {
    headers: omnigentHeaders(config, email),
  });
  await throwOnError(response, "get computer", config.secrets);
  return (await response.json()) as OmnigentComputerState;
}

/** `POST /v1/sessions/{id}/computer/screen` — `interactive: true` is Take over. */
export async function openOmnigentComputerScreen(
  config: OmnigentClientConfig,
  email: string,
  sessionId: string,
  interactive: boolean,
): Promise<OmnigentComputerScreen> {
  const response = await fetch(computerUrl(config, sessionId, "/screen"), {
    method: "POST",
    headers: omnigentHeaders(config, email),
    body: JSON.stringify({ interactive }),
  });
  await throwOnError(response, "open computer screen", config.secrets);
  return (await response.json()) as OmnigentComputerScreen;
}

/** `POST /v1/sessions/{id}/computer/release` — hand control back to the Muse. */
export async function releaseOmnigentComputer(
  config: OmnigentClientConfig,
  email: string,
  sessionId: string,
): Promise<OmnigentComputerScreen> {
  const response = await fetch(computerUrl(config, sessionId, "/release"), {
    method: "POST",
    headers: omnigentHeaders(config, email),
  });
  await throwOnError(response, "release computer", config.secrets);
  return (await response.json()) as OmnigentComputerScreen;
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
  /** First item that belongs to a with-context side chat itself (its seed checkpoint). */
  seed_item_id?: string | null;
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

/** A memory claim as the engine serves it (`memory/service.py` `_claim_to_dict`). */
export interface OmnigentMemoryClaim {
  claim_id: string;
  kind: string;
  text: string;
  origin: "said" | "edited" | "noticed";
  person_authored: boolean;
  last_confirmed: number;
}

/** `GET .../memory/claims` — every active claim, newest first. */
export async function listOmnigentMemoryClaims(
  config: OmnigentClientConfig,
  email: string,
  sessionId: string,
): Promise<OmnigentMemoryClaim[]> {
  const response = await fetch(
    new URL(`/v1/sessions/${encodeURIComponent(sessionId)}/memory/claims`, config.baseUrl),
    { headers: omnigentHeaders(config, email) },
  );
  await throwOnError(response, "list memory claims", config.secrets);
  const body = (await response.json()) as { claims?: OmnigentMemoryClaim[] };
  return body.claims ?? [];
}

/** `PATCH .../memory/claims/{id}` — the person's edit; the claim becomes person-authored. */
export async function patchOmnigentMemoryClaim(
  config: OmnigentClientConfig,
  email: string,
  sessionId: string,
  claimId: string,
  text: string,
): Promise<OmnigentMemoryClaim> {
  const response = await fetch(
    new URL(
      `/v1/sessions/${encodeURIComponent(sessionId)}/memory/claims/${encodeURIComponent(claimId)}`,
      config.baseUrl,
    ),
    { method: "PATCH", headers: omnigentHeaders(config, email), body: JSON.stringify({ text }) },
  );
  await throwOnError(response, "edit memory claim", config.secrets);
  return (await response.json()) as OmnigentMemoryClaim;
}

/** `POST .../memory/forget` with `confirm` — the person deletes one claim. */
export async function forgetOmnigentMemoryClaim(
  config: OmnigentClientConfig,
  email: string,
  sessionId: string,
  claimId: string,
): Promise<void> {
  const response = await fetch(
    new URL(`/v1/sessions/${encodeURIComponent(sessionId)}/memory/forget`, config.baseUrl),
    {
      method: "POST",
      headers: omnigentHeaders(config, email),
      body: JSON.stringify({ claim_id: claimId, confirm: true }),
    },
  );
  await throwOnError(response, "forget memory claim", config.secrets);
}

/** A daily note as the engine serves it (`routes/daily_notes.py` `note_to_response`). */
export interface OmnigentDailyNote {
  date: string;
  sections: Record<string, string>;
  edited_by_person: boolean;
  finalized: boolean;
  updated_at: number;
}

/** `GET /v1/me/daily-notes` — the person's notes, newest first. */
export async function listOmnigentDailyNotes(
  config: OmnigentClientConfig,
  email: string,
  limit = 14,
): Promise<OmnigentDailyNote[]> {
  const url = new URL("/v1/me/daily-notes", config.baseUrl);
  url.searchParams.set("limit", String(limit));
  const response = await fetch(url, { headers: omnigentHeaders(config, email) });
  await throwOnError(response, "list daily notes", config.secrets);
  const body = (await response.json()) as { daily_notes?: OmnigentDailyNote[] };
  return body.daily_notes ?? [];
}

/** `PUT /v1/me/daily-notes/{date}` — the person's edit; the engine then never rewrites it. */
export async function putOmnigentDailyNote(
  config: OmnigentClientConfig,
  email: string,
  date: string,
  sections: Record<string, string>,
): Promise<OmnigentDailyNote> {
  const response = await fetch(
    new URL(`/v1/me/daily-notes/${encodeURIComponent(date)}`, config.baseUrl),
    {
      method: "PUT",
      headers: omnigentHeaders(config, email),
      body: JSON.stringify({ sections }),
    },
  );
  await throwOnError(response, "save daily note", config.secrets);
  return (await response.json()) as OmnigentDailyNote;
}

/** `PUT /v1/me/proactivity` — the engine accepts a partial body and keeps omitted fields, so
 * sending only `timezone` leaves the person's proactivity and quiet hours alone. */
export async function putOmnigentTimezone(
  config: OmnigentClientConfig,
  email: string,
  timezone: string,
): Promise<void> {
  const response = await fetch(new URL("/v1/me/proactivity", config.baseUrl), {
    method: "PUT",
    headers: omnigentHeaders(config, email),
    body: JSON.stringify({ timezone }),
  });
  await throwOnError(response, "set timezone", config.secrets);
}

/** `PUT /v1/me/proactivity` — the level and quiet hours (`null` clears them); the timezone is kept. */
export async function putOmnigentProactivity(
  config: OmnigentClientConfig,
  email: string,
  prefs: {
    proactivity: "off" | "low" | "normal";
    quietStart: string | null;
    quietEnd: string | null;
  },
): Promise<void> {
  const response = await fetch(new URL("/v1/me/proactivity", config.baseUrl), {
    method: "PUT",
    headers: omnigentHeaders(config, email),
    body: JSON.stringify({
      proactivity: prefs.proactivity,
      quiet_start: prefs.quietStart,
      quiet_end: prefs.quietEnd,
    }),
  });
  await throwOnError(response, "set proactivity", config.secrets);
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
  source: "turn" | "side_chat" | "background" | "scheduled" | "goal";
  chat_id: string;
  title: string;
  outcome: string | null;
  summary: string | null;
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

/** A suggestion (an Idea) recorded by a background run
 * (engine/omnigent/omnigent/server/routes/suggestions.py `suggestion_to_response`). */
export interface OmnigentSuggestion {
  id: string;
  parent_session_id: string;
  title: string;
  why: string;
  /** The exact message to send to the Conversation if the person accepts it. */
  message: string;
  status: "open" | "done" | "dismissed";
  source_session_id: string | null;
  created_at: number;
  updated_at: number | null;
}

/** `GET /v1/suggestions?parent_session_id=&status=open` — newest first. */
export async function listOmnigentSuggestions(
  config: OmnigentClientConfig,
  email: string,
  parentSessionId: string,
  status: OmnigentSuggestion["status"] = "open",
): Promise<OmnigentSuggestion[]> {
  const url = new URL("/v1/suggestions", config.baseUrl);
  url.searchParams.set("parent_session_id", parentSessionId);
  url.searchParams.set("status", status);
  const response = await fetch(url, { headers: omnigentHeaders(config, email) });
  await throwOnError(response, "list suggestions", config.secrets);
  const body = (await response.json()) as { suggestions?: OmnigentSuggestion[] };
  return body.suggestions ?? [];
}

/** `PATCH /v1/suggestions/{id}` — mark it done (accepted) or dismissed. */
export async function patchOmnigentSuggestion(
  config: OmnigentClientConfig,
  email: string,
  id: string,
  status: OmnigentSuggestion["status"],
): Promise<OmnigentSuggestion> {
  const response = await fetch(
    new URL(`/v1/suggestions/${encodeURIComponent(id)}`, config.baseUrl),
    {
      method: "PATCH",
      headers: omnigentHeaders(config, email),
      body: JSON.stringify({ status }),
    },
  );
  await throwOnError(response, "update suggestion", config.secrets);
  return (await response.json()) as OmnigentSuggestion;
}

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

/** `PATCH /v1/objectives/{id}/tasks/{task_id}` — a task's status and/or note, in place. */
export async function updateOmnigentObjectiveTask(
  config: OmnigentClientConfig,
  email: string,
  objectiveId: string,
  taskId: string,
  patch: { status?: OmnigentObjectiveTask["status"]; note?: string },
): Promise<OmnigentObjectiveTask> {
  const response = await fetch(
    objectiveUrl(config, objectiveId, `/tasks/${encodeURIComponent(taskId)}`),
    {
      method: "PATCH",
      headers: omnigentHeaders(config, email),
      body: JSON.stringify(patch),
    },
  );
  await throwOnError(response, "update objective task", config.secrets);
  return (await response.json()) as OmnigentObjectiveTask;
}

/** A taught skill's document (engine/omnigent/omnigent/superchat/taught_skills.py). */
export interface OmnigentSkillDoc {
  name: string;
  goal: string;
  preconditions: string[];
  inputs: { name: string; label: string; default: string; description?: string }[];
  steps: {
    intent: string;
    check: string;
    approval: boolean;
    keyframe: string | null;
    hint?: { role?: string; name?: string; selector?: string; url?: string };
  }[];
  returns: string;
}

/** A skill taught by demonstration (routes/taught_skills.py `skill_to_response`). */
export interface OmnigentTaughtSkill {
  id: string;
  parent_session_id: string;
  recording_id: string | null;
  name: string;
  goal: string;
  status: "recording" | "drafting" | "draft" | "saved" | "failed";
  version: number;
  doc: OmnigentSkillDoc | null;
  created_at: number;
  updated_at: number | null;
  stopped_at: number | null;
  /** Only on a single-skill read. */
  keyframes?: string[];
}

function taughtSkillUrl(config: OmnigentClientConfig, id: string, tail = ""): URL {
  return new URL(`/v1/taught-skills/${encodeURIComponent(id)}${tail}`, config.baseUrl);
}

/** `POST /v1/sessions/{id}/computer/recording` `{action: "start"}`. */
export async function startOmnigentRecording(
  config: OmnigentClientConfig,
  email: string,
  sessionId: string,
  goal: string,
): Promise<{ recording_id: string; skill_id: string }> {
  const response = await fetch(computerUrl(config, sessionId, "/recording"), {
    method: "POST",
    headers: omnigentHeaders(config, email),
    body: JSON.stringify({ action: "start", goal }),
  });
  await throwOnError(response, "start recording", config.secrets);
  return (await response.json()) as { recording_id: string; skill_id: string };
}

/** `POST /v1/sessions/{id}/computer/recording` `{action: "stop"}` — the skill is then drafted. */
export async function stopOmnigentRecording(
  config: OmnigentClientConfig,
  email: string,
  sessionId: string,
): Promise<{ recording_id: string; skill_id: string }> {
  const response = await fetch(computerUrl(config, sessionId, "/recording"), {
    method: "POST",
    headers: omnigentHeaders(config, email),
    body: JSON.stringify({ action: "stop" }),
  });
  await throwOnError(response, "stop recording", config.secrets);
  return (await response.json()) as { recording_id: string; skill_id: string };
}

/** `GET /v1/taught-skills?parent_session_id=` — newest first. */
export async function listOmnigentTaughtSkills(
  config: OmnigentClientConfig,
  email: string,
  parentSessionId: string,
): Promise<OmnigentTaughtSkill[]> {
  const url = new URL("/v1/taught-skills", config.baseUrl);
  url.searchParams.set("parent_session_id", parentSessionId);
  const response = await fetch(url, { headers: omnigentHeaders(config, email) });
  await throwOnError(response, "list taught skills", config.secrets);
  const body = (await response.json()) as { skills?: OmnigentTaughtSkill[] };
  return body.skills ?? [];
}

export async function getOmnigentTaughtSkill(
  config: OmnigentClientConfig,
  email: string,
  id: string,
): Promise<OmnigentTaughtSkill> {
  const response = await fetch(taughtSkillUrl(config, id), {
    headers: omnigentHeaders(config, email),
  });
  await throwOnError(response, "get taught skill", config.secrets);
  return (await response.json()) as OmnigentTaughtSkill;
}

/** One keyframe of a skill's recording as a `data:` URI, or `null` when it is gone. */
export async function getOmnigentSkillKeyframe(
  config: OmnigentClientConfig,
  email: string,
  id: string,
  name: string,
): Promise<string | null> {
  const response = await fetch(
    taughtSkillUrl(config, id, `/keyframes/${encodeURIComponent(name)}`),
    {
      headers: omnigentHeaders(config, email),
    },
  );
  if (response.status === 404) return null;
  await throwOnError(response, "get keyframe", config.secrets);
  const bytes = Buffer.from(await response.arrayBuffer());
  return `data:image/jpeg;base64,${bytes.toString("base64")}`;
}

/** `PUT /v1/taught-skills/{id}/doc` — a new version of the document. */
export async function putOmnigentTaughtSkillDoc(
  config: OmnigentClientConfig,
  email: string,
  id: string,
  doc: OmnigentSkillDoc,
): Promise<OmnigentTaughtSkill> {
  const response = await fetch(taughtSkillUrl(config, id, "/doc"), {
    method: "PUT",
    headers: omnigentHeaders(config, email),
    body: JSON.stringify({ doc }),
  });
  await throwOnError(response, "save skill draft", config.secrets);
  return (await response.json()) as OmnigentTaughtSkill;
}

export async function saveOmnigentTaughtSkill(
  config: OmnigentClientConfig,
  email: string,
  id: string,
): Promise<OmnigentTaughtSkill> {
  const response = await fetch(taughtSkillUrl(config, id, "/save"), {
    method: "POST",
    headers: omnigentHeaders(config, email),
  });
  await throwOnError(response, "save skill", config.secrets);
  return (await response.json()) as OmnigentTaughtSkill;
}

/** `POST /v1/taught-skills/{id}/render` — the text a turn follows, with inputs filled in. */
export async function renderOmnigentTaughtSkill(
  config: OmnigentClientConfig,
  email: string,
  id: string,
  inputs: Record<string, string> = {},
): Promise<{ skill_id: string; name: string; text: string; missing_inputs: string[] }> {
  const response = await fetch(taughtSkillUrl(config, id, "/render"), {
    method: "POST",
    headers: omnigentHeaders(config, email),
    body: JSON.stringify({ inputs }),
  });
  await throwOnError(response, "render skill", config.secrets);
  return (await response.json()) as {
    skill_id: string;
    name: string;
    text: string;
    missing_inputs: string[];
  };
}

export async function deleteOmnigentTaughtSkill(
  config: OmnigentClientConfig,
  email: string,
  id: string,
): Promise<void> {
  const response = await fetch(taughtSkillUrl(config, id), {
    method: "DELETE",
    headers: omnigentHeaders(config, email),
  });
  await throwOnError(response, "delete taught skill", config.secrets);
}
