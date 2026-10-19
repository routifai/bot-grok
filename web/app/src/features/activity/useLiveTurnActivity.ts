import { useEffect, useState } from "react";
import { rpc } from "../../lib/rpc";

// The running turn's Activity before any reply names it (ADR 0027): the Conversation's status
// carries its id while a turn runs, so its steps show from the first tool call, not from the
// first reply.

/** How long a dropped status stream waits before it is opened again. */
const STATUS_RETRY_MS = 3_000;

/** The Activity the Conversation's running turn writes, from its status; null while none runs. */
export function useLiveTurnActivity(
  botId: string | undefined,
  chatId: string | null | undefined,
  running: boolean,
): string | null {
  const [activityId, setActivityId] = useState<string | null>(null);
  useEffect(() => {
    setActivityId(null);
    if (!botId || !chatId || !running) return;
    const abort = new AbortController();
    void (async () => {
      while (!abort.signal.aborted) {
        try {
          const frames = await rpc.chats.watchStatus({ botId, chatId }, { signal: abort.signal });
          for await (const frame of frames) {
            if (abort.signal.aborted) return;
            // A running frame that names no Activity keeps the one named before.
            setActivityId((current) =>
              frame.status === "running" ? (frame.activityId ?? current) : null,
            );
          }
        } catch {
          // Dropped: try again shortly.
        }
        if (abort.signal.aborted) return;
        await new Promise((resolve) => setTimeout(resolve, STATUS_RETRY_MS));
      }
    })();
    return () => abort.abort();
  }, [botId, chatId, running]);
  return activityId;
}
