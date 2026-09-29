import type { EngineInfo, NovaHarnessId } from "@aiden/contracts";
import { useCallback, useEffect, useState } from "react";
import { rpc } from "../../../lib/rpc";

/** Which harness this Muse runs on, and the ones it could switch to. */
export function useEngine(botId: string | null | undefined) {
  const [info, setInfo] = useState<EngineInfo | null>(null);
  const [switching, setSwitching] = useState<NovaHarnessId | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!botId) return;
    let cancelled = false;
    void rpc.engine
      .info({ botId })
      .then((next) => {
        if (!cancelled) setInfo(next);
      })
      .catch(() => {
        if (!cancelled) setInfo(null);
      });
    return () => {
      cancelled = true;
    };
  }, [botId]);

  const choose = useCallback(
    async (harness: NovaHarnessId) => {
      if (!botId || !info || harness === info.active) return;
      const previous = info;
      setSwitching(harness);
      setError(null);
      // Show the choice at once; the next message starts on it.
      setInfo({ ...info, active: harness });
      try {
        setInfo(await rpc.engine.setHarness({ botId, harness }));
      } catch (err) {
        setInfo(previous);
        setError(err instanceof Error ? err.message : "Could not switch.");
      } finally {
        setSwitching(null);
      }
    },
    [botId, info],
  );

  return { info, choose, switching, error };
}
