import type { Activity } from "@aiden/contracts";
import { ORPCError } from "@orpc/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { rpc } from "../../../lib/rpc";
import {
  ACTIVITY_POLL_IDLE_MS,
  activitiesPollIntervalMs,
  mergeNewestPage,
} from "./activityGrouping";

/** The Activity panel's wire: a Muse's Activity Feed, or why it can't be shown. */
export type ActivitiesState =
  | { status: "loading" }
  | { status: "ready"; activities: Activity[]; hasMore: boolean }
  | { status: "unavailable" }
  | { status: "error" };

const PAGE_SIZE = 30;

// `NOT_IMPLEMENTED`: the backend doesn't serve `activities.*` in this environment.
// `NOT_FOUND`: this Muse has no Conversation yet (a brand new Muse) — both are the
// calm "nothing yet" state, never "Could not load…" (docs/super-chat/README.md: the
// Activity panel's own empty state already says this plainly).
const isUnavailable = (error: unknown) =>
  error instanceof ORPCError && (error.code === "NOT_IMPLEMENTED" || error.code === "NOT_FOUND");

function epochSeconds(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

/**
 * The Activity panel's data (docs/super-chat/WIRING.md "Activity panel"): the newest page
 * from `activities.list`, polled while the tab is visible — briskly while something is
 * still in progress, relaxed once it has settled (activitiesPollIntervalMs), and paused
 * while the document is hidden, resuming (with an immediate refresh) when it isn't.
 */
export function useActivities(botId: string): {
  state: ActivitiesState;
  loadEarlier: () => Promise<void>;
  loadingEarlier: boolean;
} {
  const [state, setState] = useState<ActivitiesState>({ status: "loading" });
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const generation = useRef(0);
  const stateRef = useRef<ActivitiesState>(state);
  stateRef.current = state;
  const timer = useRef<number | undefined>(undefined);

  const load = useCallback(() => {
    const current = ++generation.current;
    return rpc.activities
      .list({ botId, limit: PAGE_SIZE })
      .then((page) => {
        if (current !== generation.current) return;
        // The poll only ever re-fetches the newest page. Merge it into whatever's
        // already loaded (which may include older pages from "Load earlier") instead of
        // replacing the list outright, and leave `hasMore` as it was — it describes
        // pagination past the *oldest* loaded Activity, which this fetch says nothing
        // about. Only the very first load (nothing "ready" yet) takes the page as-is.
        setState((prev) =>
          prev.status === "ready"
            ? {
                status: "ready",
                activities: mergeNewestPage(prev.activities, page.activities),
                hasMore: prev.hasMore,
              }
            : { status: "ready", activities: page.activities, hasMore: page.hasMore },
        );
      })
      .catch((error: unknown) => {
        if (current !== generation.current) return;
        setState({ status: isUnavailable(error) ? "unavailable" : "error" });
      });
  }, [botId]);

  useEffect(() => {
    generation.current += 1;
    setState({ status: "loading" });
    let cancelled = false;

    const tick = () => {
      if (cancelled) return;
      void load().finally(() => {
        if (cancelled || document.visibilityState !== "visible") return;
        const interval =
          stateRef.current.status === "ready"
            ? activitiesPollIntervalMs(stateRef.current.activities)
            : ACTIVITY_POLL_IDLE_MS;
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(tick, interval);
      });
    };

    const onVisibilityChange = () => {
      window.clearTimeout(timer.current);
      if (document.visibilityState === "visible") tick();
    };

    tick();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.clearTimeout(timer.current);
    };
  }, [botId, load]);

  const loadEarlier = useCallback(async () => {
    const current = stateRef.current;
    if (current.status !== "ready" || !current.hasMore || loadingEarlier) return;
    const oldest = current.activities.at(-1);
    if (!oldest) return;
    setLoadingEarlier(true);
    try {
      const page = await rpc.activities.list({
        botId,
        before: epochSeconds(oldest.startedAt),
        limit: PAGE_SIZE,
      });
      setState((prev) =>
        prev.status === "ready"
          ? {
              status: "ready",
              activities: [...prev.activities, ...page.activities],
              hasMore: page.hasMore,
            }
          : prev,
      );
    } catch {
      // Keep what's already shown; the "Load earlier" action stays, so trying again is a
      // click away rather than a forced retry.
    } finally {
      setLoadingEarlier(false);
    }
  }, [botId, loadingEarlier]);

  return { state, loadEarlier, loadingEarlier };
}
