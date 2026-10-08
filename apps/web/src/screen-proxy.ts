import type { IncomingHttpHeaders } from "node:http";
import type { ScreenProxyTarget } from "@nova/core/node/screen-capability";
import {
  isScreenProxyTarget,
  SCREEN_RECHECK_MS,
  SCREEN_TARGET_ENDPOINT,
} from "@nova/core/node/screen-capability";

const SENSITIVE_FORWARD_HEADERS = new Set([
  "authorization",
  "cookie",
  "host",
  "proxy-authenticate",
  "proxy-authorization",
]);

export type NovncTargetCheck =
  | { status: "allowed"; target: ScreenProxyTarget }
  | { status: "denied" }
  | { status: "unavailable" };

/**
 * Ask the API about a screen capability. "denied" is the API's answer (revoked, expired,
 * malformed); "unavailable" means no answer (restart, timeout, 5xx), which an open stream
 * rides out for a short grace while a new connection still fails closed.
 */
export async function checkNovncTarget(
  url: string | undefined,
  secret: string,
  api: string,
): Promise<NovncTargetCheck> {
  if (!url?.startsWith("/novnc/session/")) return { status: "denied" };
  try {
    const response = await fetch(new URL(SCREEN_TARGET_ENDPOINT, api), {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(2_000),
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ path: url }),
    });
    if (response.status >= 500) return { status: "unavailable" };
    if (!response.ok) return { status: "denied" };
    const target: unknown = await response.json();
    return isScreenProxyTarget(target) ? { status: "allowed", target } : { status: "denied" };
  } catch {
    return { status: "unavailable" };
  }
}

/**
 * Fail closed when the authoritative lifecycle check is unavailable. An API that gives no
 * answer (hot reload, restart) is retried briefly first, so a page load or reconnect that
 * lands in that window does not become a 403 and a black frame.
 */
export async function resolveNovncTarget(
  url: string | undefined,
  secret: string,
  api: string,
  retries = 2,
  retryDelayMs = 300,
): Promise<ScreenProxyTarget | null> {
  for (let attempt = 0; ; attempt++) {
    const result = await checkNovncTarget(url, secret, api);
    if (result.status === "allowed") return result.target;
    if (result.status === "denied" || attempt >= retries) return null;
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }
}

function isHttp2PseudoHeader(key: string) {
  return key.startsWith(":");
}

export function safeProxyHeaders(headers: IncomingHttpHeaders) {
  return Object.fromEntries(
    Object.entries(headers).filter(([key, value]) => {
      return (
        value != null &&
        !isHttp2PseudoHeader(key) &&
        !SENSITIVE_FORWARD_HEADERS.has(key.toLowerCase())
      );
    }),
  );
}

/** How long an open stream tolerates an API that gives no answer before it is closed. */
export const SCREEN_AUTH_GRACE_MS = 15_000;

/**
 * Recheck streams as well as new requests; no positive authorization cache. A check may
 * answer "unavailable" (the API restarting or slow): the stream is kept for the grace
 * window instead of dying on the first missed answer, which showed up as a black screen.
 */
export function watchScreenAuthorization(
  check: () => Promise<boolean | "unavailable">,
  revoke: () => void,
  graceMs = SCREEN_AUTH_GRACE_MS,
) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  let unavailableSince: number | null = null;
  const tick = async () => {
    let allowed: boolean | "unavailable" = false;
    try {
      allowed = await check();
    } catch {
      /* Fail closed. */
    }
    if (stopped) return;
    if (allowed === "unavailable") {
      unavailableSince ??= Date.now();
      allowed = Date.now() - unavailableSince < graceMs;
    } else {
      unavailableSince = null;
    }
    if (!allowed) {
      stopped = true;
      revoke();
      return;
    }
    timer = setTimeout(tick, SCREEN_RECHECK_MS);
    timer.unref?.();
  };
  timer = setTimeout(tick, SCREEN_RECHECK_MS);
  timer.unref?.();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
