// Minimal typed client for the Omnigent REST API (engine/omnigent/omnigent/server/API.md,
// engine/omnigent/openapi.json), used by ./gateway.ts to run a Nova turn on Omnigent
// (docs/omnigent-spike.md). Every call carries the identity/proxy
// headers Omnigent's header auth mode expects — no SDK dependency, just fetch and a tiny
// SSE line parser mirroring apps/mobile/lib/api.ts's `subscribeThread`.
import { redactSecrets } from "@nova/core";

/** How to reach the engine (env `OMNIGENT_URL` / `OMNIGENT_PROXY_SECRET`), before a caller's
 * tenant is known. Bind one with `omnigentClientFor` to make calls. */
export interface OmnigentConnection {
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

/** A connection bound to the caller's tenant: the Nova space id, sent on every call so the
 * engine scopes per-person resources (`/v1/me/muse`, the Muse's Computer) to that space. */
export interface OmnigentClientConfig extends OmnigentConnection {
  tenant: string;
}

/** The header the engine reads the tenant from; the engine's `OMNIGENT_AUTH_TENANT_HEADER`
 * must name it. */
export const OMNIGENT_TENANT_HEADER = "X-Omnigent-Tenant";

export function omnigentClientFor(
  connection: OmnigentConnection,
  tenant: string,
): OmnigentClientConfig {
  return { ...connection, tenant };
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

export function omnigentHeaders(
  config: OmnigentClientConfig,
  email: string,
): Record<string, string> {
  return {
    "content-type": "application/json",
    "X-Forwarded-Email": email,
    "X-Omnigent-Proxy-Secret": config.proxySecret,
    [OMNIGENT_TENANT_HEADER]: config.tenant,
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

export function errorCodeFromBody(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as { error?: { code?: unknown } };
    return typeof parsed.error?.code === "string" ? parsed.error.code : undefined;
  } catch {
    return undefined;
  }
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
export async function throwOnError(
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

/** What a person sees for an engine error code that can reach the UI (wording is Nova's; the
 * engine sends only the code). */
const ERROR_COPY: Record<string, string> = {
  helper_read_only: "Helpers are read-only.",
  superchat_not_configured: "Chat is not available right now.",
  muse_already_set: "You already have a Conversation here.",
  muse_tenant_mismatch: "This Conversation belongs to another space.",
  not_a_super_chat: "This chat can't be your Conversation.",
};

/** Short client copy for an engine error, or `undefined` when its code has none. */
export function omnigentErrorCopy(error: unknown): string | undefined {
  return error instanceof OmnigentApiError && error.code ? ERROR_COPY[error.code] : undefined;
}
