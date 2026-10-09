import type { ComputerStatus } from "@nova/contracts";
import { useRef, useState } from "react";

/** Last-known computer status and screen link per bot, plus the refs the thread loader and the
 * computer panel share. */
export function useComputerStore() {
  const [computer, setComputer] = useState<ComputerStatus | null>(null);
  const computerRef = useRef<ComputerStatus | null>(null);
  // Last-known computer/screen per bot, so switching back to an already-seen
  // bot paints its computer pane instantly instead of blanking it while the
  // thread + screen RPCs round-trip again (see refreshThread / refreshComputerScreen).
  const computerCacheRef = useRef(
    new Map<string, { computer: ComputerStatus | null; screenUrl: string | null }>(),
  );
  // Caps computerCacheRef so a long session that opens many distinct bots
  // over time doesn't accumulate one entry per bot forever. Re-inserting on
  // every update keeps Map iteration order as least-recently-used first, so
  // eviction drops the bot that's been out of view longest.
  const COMPUTER_CACHE_LIMIT = 20;

  function cacheComputerFor(
    botId: string,
    patch: Partial<{ computer: ComputerStatus | null; screenUrl: string | null }>,
  ) {
    const cache = computerCacheRef.current;
    const prev = cache.get(botId) ?? { computer: null, screenUrl: null };
    cache.delete(botId);
    cache.set(botId, { ...prev, ...patch });
    if (cache.size > COMPUTER_CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }

  // Who wants every status event as it lands (an attachment waiting for the Computer to wake).
  const listenersRef = useRef(new Set<(status: ComputerStatus | null) => void>());
  function onComputerChange(listener: (status: ComputerStatus | null) => void) {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }

  function commitComputer(next: ComputerStatus | null) {
    computerRef.current = next;
    setComputer(next);
    for (const listener of listenersRef.current) listener(next);
  }
  const computerOpenRef = useRef(false);
  const computerBotIdRef = useRef<string | undefined>(undefined);
  const computerVisible = useRef(false);
  // What each held screen link was minted for; see screenLinkKey.
  const screenLinkKeys = useRef(new Map<string, string>());
  return {
    computer,
    computerRef,
    computerCacheRef,
    cacheComputerFor,
    commitComputer,
    onComputerChange,
    computerOpenRef,
    computerBotIdRef,
    computerVisible,
    screenLinkKeys,
  };
}
