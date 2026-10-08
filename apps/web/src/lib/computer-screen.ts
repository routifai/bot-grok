import type { ComputerStatus } from "@nova/contracts";

export interface ComputerScreenResult {
  url: string | null;
  error: string | null;
}

/** Only the latest request for the visible computer may replace its screen or error. */
export async function loadComputerScreen(options: {
  load: () => Promise<{ url: string | null }>;
  isCurrent: () => boolean;
  commit: (result: ComputerScreenResult) => void;
  fallbackError: string;
}): Promise<string | null> {
  let result: ComputerScreenResult;
  try {
    const screen = await options.load();
    result = { url: screen.url, error: null };
  } catch (error) {
    result = {
      url: null,
      error: error instanceof Error && error.message ? error.message : options.fallbackError,
    };
  }
  if (!options.isCurrent()) return null;
  options.commit(result);
  return result.url;
}

export function embeddableScreenUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url, window.location.href);
    const page = new URL(window.location.href);
    const local = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
    const pagePort = page.port || (page.protocol === "https:" ? "443" : "80");
    if (local && parsed.port && parsed.port !== pagePort) {
      return null;
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

export function screenIframeSandbox(url: string | null) {
  if (!url) return undefined;
  try {
    return new URL(url, window.location.href).pathname.startsWith("/novnc/")
      ? "allow-scripts allow-pointer-lock"
      : undefined;
  } catch {
    return undefined;
  }
}

const SCREEN_URL_REFRESH_MARGIN_MS = 5 * 60_000;
const SCREEN_CAPABILITY_PATH = /\/novnc\/session\/(view|control)\/(\d+)\./;

/**
 * A screen link we already hold stays in use while its capability is valid. Re-fetching it
 * mints a new capability (new expiry, new URL), which reloads the embedded desktop and
 * flashes black, so only non-capability links or ones near expiry count as stale.
 */
export function screenUrlStillFresh(
  url: string | null | undefined,
  now = Date.now(),
  marginMs = SCREEN_URL_REFRESH_MARGIN_MS,
): boolean {
  if (!url) return false;
  const match = SCREEN_CAPABILITY_PATH.exec(url);
  if (!match) return false;
  return Number(match[2]) - now > marginMs;
}

/**
 * What a screen link depends on. Each run briefly reconnects the computer (booting, then
 * running) and hands control to the bot and back; neither changes the link, so only a lost
 * screen or the person taking or returning control needs a new one.
 */
export function screenLinkKey(
  status: Pick<ComputerStatus, "state" | "controlHolder" | "screenAvailable"> | null,
): string {
  if (!status) return "none";
  const live = status.state === "running" || status.state === "booting";
  return `${live && status.screenAvailable ? "live" : status.state}:${status.controlHolder === "user" ? "user" : "bot"}`;
}

/**
 * Run `start` once per key while a run is in flight. Opening the computer view triggers
 * several refreshes at once; each would mint its own screen link and queue behind the other
 * on the supervisor's screen lock. `replace` starts a fresh run that later callers share.
 */
export function shareInflight<T>(
  inflight: Map<string, Promise<T>>,
  key: string,
  start: () => Promise<T>,
  replace = false,
): Promise<T> {
  const pending = inflight.get(key);
  if (pending && !replace) return pending;
  const run = start();
  inflight.set(key, run);
  const settle = () => {
    if (inflight.get(key) === run) inflight.delete(key);
  };
  run.then(settle, settle);
  return run;
}
