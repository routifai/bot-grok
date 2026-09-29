// Minimal typed client for the Omnigent REST API (engine/omnigent/omnigent/server/API.md,
// engine/omnigent/openapi.json), used by ./gateway.ts to run a Nova turn on Omnigent
// (NOVA_ENGINE=omnigent, docs/omnigent-spike.md). Every call carries the identity/proxy
// headers Omnigent's header auth mode expects — no SDK dependency, just fetch and a tiny
// SSE line parser mirroring apps/mobile/lib/api.ts's `subscribeThread`.

export interface OmnigentClientConfig {
  /** Base URL of the Omnigent server, e.g. "http://127.0.0.1:8000". */
  baseUrl: string;
  /** Shared secret Omnigent's header-auth proxy mode expects on every request. */
  proxySecret: string;
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

async function throwOnError(response: Response, what: string): Promise<Response> {
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`omnigent ${what} failed (${response.status}): ${body.slice(0, 500)}`);
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
  await throwOnError(response, "create session");
  return (await response.json()) as OmnigentSessionResponse;
}

/**
 * `GET /v1/sessions/{id}` — a cheap session snapshot (no items/liveness/usage), used by
 * ./gateway.ts to check whether a reused session ever got a runner bound (`host_id`). A pre-fix
 * session created with no `host_type` binds no host at all and stays that way forever — see
 * ensureOmnigentSession's repair path.
 */
export async function getOmnigentSession(
  config: OmnigentClientConfig,
  email: string,
  sessionId: string,
): Promise<OmnigentSessionResponse & { host_id?: string | null }> {
  const url = new URL(`/v1/sessions/${encodeURIComponent(sessionId)}`, config.baseUrl);
  url.searchParams.set("include_items", "false");
  url.searchParams.set("include_liveness", "false");
  url.searchParams.set("include_usage", "false");
  const response = await fetch(url, { headers: omnigentHeaders(config, email) });
  await throwOnError(response, "get session");
  return (await response.json()) as OmnigentSessionResponse & { host_id?: string | null };
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
  await throwOnError(response, "list hosts");
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
  await throwOnError(response, "list host directory");
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
  await throwOnError(response, "create host directory");
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
  await throwOnError(response, "list agents");
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
  await throwOnError(response, "post message event");
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
  await throwOnError(response, "switch agent");
  return (await response.json()) as OmnigentSessionResponse;
}

/** `GET /v1/sessions/{id}/items` — the committed conversation transcript, paginated. */
export async function listOmnigentSessionItems(
  config: OmnigentClientConfig,
  email: string,
  sessionId: string,
): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(
    new URL(`/v1/sessions/${encodeURIComponent(sessionId)}/items`, config.baseUrl),
    { headers: omnigentHeaders(config, email) },
  );
  await throwOnError(response, "list session items");
  const body = (await response.json()) as { data?: Array<Record<string, unknown>> };
  return body.data ?? [];
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
  await throwOnError(response, "stream session");
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
