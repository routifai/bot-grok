import type { ComputerStatus } from "@nova/contracts";
import { useEffect, useState } from "react";
import { rpc } from "../../lib/rpc";

type Launch = NonNullable<ComputerStatus["launch"]>;

/** The Computer's start-up is brief and its stages move in seconds, so a short poll while a turn
 * is running is enough; nothing polls while idle. */
const POLL_INTERVAL_MS = 3_000;
/** The header and the transcript read the launch at once: they share one request. */
const inFlight = new Map<string, Promise<Launch | undefined>>();

function readLaunch(botId: string): Promise<Launch | undefined> {
  const pending = inFlight.get(botId);
  if (pending) return pending;
  const request = rpc.computer
    .status({ botId })
    .then((status) => status.launch)
    .finally(() => inFlight.delete(botId));
  inFlight.set(botId, request);
  return request;
}

/** The stage of a Computer start-up in progress (or failed), polled only while `active`; `undefined`
 * when the Computer is up, there is none, or the status cannot be read. */
export function useComputerLaunch(botId: string, active: boolean): Launch | undefined {
  const [launch, setLaunch] = useState<Launch | undefined>();
  useEffect(() => {
    if (!active || !botId) {
      setLaunch(undefined);
      return;
    }
    let cancelled = false;
    const poll = () =>
      readLaunch(botId).then(
        (next) => {
          if (!cancelled) setLaunch(next);
        },
        () => undefined,
      );
    void poll();
    const timer = window.setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [botId, active]);
  return launch;
}
