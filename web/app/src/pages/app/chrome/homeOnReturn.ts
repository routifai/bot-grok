import { useEffect, useRef } from "react";

/** Where the last moment the person had the app in view is kept (this browser only). */
export const LAST_SEEN_KEY = "superchat.home.lastSeen";
/** Away this long or more, the app opens on Home (ADR 0035, amended). */
export const HOME_AFTER_MS = 4 * 60 * 60 * 1000;
/** How often the stamp is renewed while the app is in view. */
const STAMP_MS = 60_000;

function readLastSeen(): number | null {
  try {
    const value = Number(window.localStorage.getItem(LAST_SEEN_KEY));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function stamp(now: number): void {
  try {
    window.localStorage.setItem(LAST_SEEN_KEY, String(now));
  } catch {
    // Storage is off (a private window): every load counts as a first visit.
  }
}

/** Whether a person last seen at *lastSeen* (`null`: never) is back after a break. */
export function backAfterBreak(lastSeen: number | null, now: number): boolean {
  return lastSeen === null || now - lastSeen >= HOME_AFTER_MS;
}

/** Whether this load opens on Home: a first visit, or the first after 4 hours or more away. */
export function opensOnHome(now = Date.now()): boolean {
  return backAfterBreak(readLastSeen(), now);
}

/**
 * Keeps the last-seen stamp while the app is in view, and calls *onReturn* when the person
 * comes back to the page after 4 hours or more away.
 */
export function useHomeOnReturn(onReturn: () => void): void {
  const latest = useRef(onReturn);
  latest.current = onReturn;
  useEffect(() => {
    stamp(Date.now());
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") stamp(Date.now());
    }, STAMP_MS);
    const onVisibility = () => {
      const now = Date.now();
      if (document.visibilityState !== "visible") {
        stamp(now);
        return;
      }
      if (backAfterBreak(readLastSeen(), now)) latest.current();
      stamp(now);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
}
