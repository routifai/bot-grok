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

export function omnigentHeaders(
  config: OmnigentClientConfig,
  email: string,
): Record<string, string> {
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
