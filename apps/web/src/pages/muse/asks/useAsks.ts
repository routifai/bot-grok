import type { Ask } from "@aiden/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { rpc } from "../../../lib/rpc";

// Gentle poll: Shell's bot-list refresh (Shell.tsx) uses 3s because bots change
// constantly; Asks are rarer, so this stays light and still catches up instantly
// on focus/visibility (same pattern as that refresh).
const POLL_INTERVAL_MS = 15_000;
/** Fired after an Ask is answered so every surface showing that Muse's Asks refreshes at once. */
const ASKS_CHANGED_EVENT = "muse:asks-changed";

/** Tell every open Asks list (Waiting on you, the context panel, badges) to refresh. */
export function notifyAsksChanged(botId: string): void {
  window.dispatchEvent(new CustomEvent(ASKS_CHANGED_EVENT, { detail: { botId } }));
}

export type AnswerAskInput = { askId: string; runId: string; answer: string };

export type UseAsksResult = {
  /** Every open Ask, newest first. */
  asks: Ask[];
  /** Open-Ask count; derived from `asks` so the list and the badge never drift. */
  count: number;
  loading: boolean;
  answer: (input: AnswerAskInput) => Promise<void>;
};

function newestFirst(asks: Ask[]): Ask[] {
  return [...asks].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}

/**
 * Single source of truth for open Asks on the client (CONTEXT.md: "answering it
 * anywhere closes it everywhere"). The Waiting-on-you sheet, the Feed, and the
 * avatar's badge all read this same hook so answering in one place updates
 * every surface without a second round of state to keep in sync.
 */
export function useAsks(botId: string): UseAsksResult {
  const [asks, setAsks] = useState<Ask[]>([]);
  const [loading, setLoading] = useState(true);
  const requestId = useRef(0);

  const refresh = useCallback(async () => {
    const id = ++requestId.current;
    try {
      const next = await rpc.asks.list({ botId });
      if (id !== requestId.current) return;
      setAsks(newestFirst(next));
    } catch {
      // Keep the last known list on a transient failure; the next poll retries.
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [botId]);

  useEffect(() => {
    setLoading(true);
    void refresh();
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const onChanged = (event: Event) => {
      if ((event as CustomEvent<{ botId: string }>).detail?.botId === botId) void refresh();
    };
    window.addEventListener("focus", onVisible);
    window.addEventListener(ASKS_CHANGED_EVENT, onChanged);
    document.addEventListener("visibilitychange", onVisible);
    const poll = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_INTERVAL_MS);
    return () => {
      window.removeEventListener("focus", onVisible);
      window.removeEventListener(ASKS_CHANGED_EVENT, onChanged);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(poll);
    };
  }, [botId, refresh]);

  const answer = useCallback(
    async (input: AnswerAskInput) => {
      let removed: Ask | undefined;
      setAsks((current) => {
        removed = current.find((ask) => ask.id === input.askId);
        return current.filter((ask) => ask.id !== input.askId);
      });
      try {
        await rpc.asks.answer(input);
        notifyAsksChanged(botId);
      } catch (err) {
        setAsks((current) =>
          removed && !current.some((ask) => ask.id === removed?.id)
            ? newestFirst([...current, removed])
            : current,
        );
        throw err;
      }
    },
    [botId],
  );

  return { asks, count: asks.length, loading, answer };
}
