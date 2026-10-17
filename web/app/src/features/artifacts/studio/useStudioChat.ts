import type { ThreadMessage } from "@superchat/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { watchFamily } from "../../../lib/family-stream";
import { rpc } from "../../../lib/rpc";
import { useVisiblePoll } from "../../../lib/use-visible-poll";
import { notifyArtifactsChanged } from "../artifactChanges";

/** How often an open studio re-reads its chat (a request just sent shows before its reply). */
const CHAT_POLL_MS = 3000;
/** How often an open studio tells the engine it is still open (its runner stays warm). */
export const OPEN_SIGNAL_MS = 5 * 60_000;
/** Before the status watch reconnects after it drops. */
const STATUS_RETRY_MS = 3000;

export type StudioChat = {
  /** The file's studio session, once found or made. */
  sessionId: string | null;
  /** Its transcript, oldest first. */
  messages: ThreadMessage[];
  /** A studio turn is running (in this tab or another). */
  running: boolean;
  /** The session could not be opened. */
  failed: boolean;
  /** The engine's words while a studio turn waits for a slot ("Finishing another file
   * first"), from the session's status; null otherwise. */
  blockedOn: string | null;
};

/**
 * The file's studio chat (ADR 0024): finds or makes its session (`artifacts.chat`, which never
 * wakes the host), reads its transcript, and follows the Muse's family stream for that session's
 * turns and for saves of the file (`artifactsChanged`, which `onSaved` answers).
 */
export function useStudioChat({
  artifactId,
  botId,
  groupId,
  onSaved,
}: {
  /** Any version of the file. */
  artifactId: string;
  botId: string | null;
  groupId: string | null;
  onSaved?: () => void;
}): StudioChat {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [running, setRunning] = useState(false);
  const [blockedOn, setBlockedOn] = useState<string | null>(null);
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    void rpc.artifacts
      .chat({ artifactId })
      .then((opened) => {
        if (!cancelled) setSessionId(opened.sessionId);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
    // One session per file, whichever version was opened: not refetched when the version moves.
  }, [artifactId]);

  // The studio is open: the engine keeps its runner warm while it hears this (ADR 0024
  // "Runner"). Only the studio sends it, never the panel.
  useEffect(() => {
    const signal = () => void rpc.artifacts.chatOpen({ artifactId }).catch(() => {});
    signal();
    const timer = window.setInterval(signal, OPEN_SIGNAL_MS);
    return () => window.clearInterval(timer);
  }, [artifactId]);

  // The session's status: `blockedOn` while a turn waits behind the host's studio cap.
  useEffect(() => {
    if (!botId || !sessionId) return;
    const abort = new AbortController();
    void (async () => {
      while (!abort.signal.aborted) {
        try {
          const frames = await rpc.chats.watchStatus(
            { botId, chatId: sessionId },
            { signal: abort.signal },
          );
          for await (const frame of frames) {
            if (abort.signal.aborted) return;
            setBlockedOn(frame.status === "running" ? frame.blockedOn : null);
            if (frame.status === "running") setRunning(true);
          }
        } catch {
          // Dropped: try again shortly.
        }
        if (abort.signal.aborted) return;
        await new Promise((resolve) => setTimeout(resolve, STATUS_RETRY_MS));
      }
    })();
    return () => abort.abort();
  }, [botId, sessionId]);

  const read = useCallback(async () => {
    if (!botId || !sessionId) return;
    const page = await rpc.chats.transcript({ botId, chatId: sessionId }).catch(() => null);
    if (!page) return;
    setMessages(page.messages);
    setRunning(page.running === true);
  }, [botId, sessionId]);

  useEffect(() => {
    void read();
  }, [read]);
  useVisiblePoll(read, CHAT_POLL_MS, !!botId && !!sessionId);

  useEffect(() => {
    if (!botId || !sessionId) return;
    return watchFamily(botId, (event) => {
      if (
        (event.type === "messageDone" ||
          event.type === "messageDelivery" ||
          event.type === "turnDone") &&
        event.chatId === sessionId
      ) {
        if (event.type === "turnDone") {
          setRunning(false);
          setBlockedOn(null);
        }
        void read();
      } else if (event.type === "artifactsChanged" && event.groupId === groupId) {
        onSavedRef.current?.();
        // The card and the Library under the studio follow the new version too.
        notifyArtifactsChanged();
      } else if (event.type === "open") {
        void read();
      }
    });
  }, [botId, sessionId, groupId, read]);

  return { sessionId, messages, running, failed, blockedOn };
}
