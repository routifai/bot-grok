import type { ComputerStatus } from "@superchat/contracts";
import { useRef, useState } from "react";

/** Last-known computer status per bot, plus the refs the thread loader and the composer share. */
export function useComputerStore() {
  const [computer, setComputer] = useState<ComputerStatus | null>(null);
  const computerRef = useRef<ComputerStatus | null>(null);
  // Last-known computer per bot, so switching back to an already-seen bot paints its status
  // instantly instead of blanking it while the thread RPC round-trips again (see refreshThread).
  const computerCacheRef = useRef(new Map<string, { computer: ComputerStatus | null }>());
  // Caps computerCacheRef so a long session that opens many distinct bots
  // over time doesn't accumulate one entry per bot forever. Re-inserting on
  // every update keeps Map iteration order as least-recently-used first, so
  // eviction drops the bot that's been out of view longest.
  const COMPUTER_CACHE_LIMIT = 20;

  function cacheComputerFor(botId: string, entry: { computer: ComputerStatus | null }) {
    const cache = computerCacheRef.current;
    cache.delete(botId);
    cache.set(botId, entry);
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
  return {
    computer,
    computerRef,
    computerCacheRef,
    cacheComputerFor,
    commitComputer,
    onComputerChange,
  };
}
