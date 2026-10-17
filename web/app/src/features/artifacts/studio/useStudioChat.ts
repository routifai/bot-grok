import type { ThreadMessage } from "@superchat/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { watchFamily } from "../../../lib/family-stream";
import { rpc } from "../../../lib/rpc";
import { useVisiblePoll } from "../../../lib/use-visible-poll";
import { notifyArtifactsChanged } from "../artifactChanges";

/** How often the chat is re-read while a turn runs and the session's stream is down. */
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
  /** A studio turn is running (in this tab or another): the studio's one running state. */
  running: boolean;
  /** A request was just sent from this tab: running until the turn says otherwise. */
  sent: () => void;
  /** The session could not be opened. */
  failed: boolean;
  /** The engine's words while a studio turn waits for a slot ("Finishing another file
   * first"), from the session's status; null otherwise. */
  blockedOn: string | null;
};

/**
 * The file's studio chat (ADR 0024): finds or makes its session (`artifacts.chat`, which never
 * wakes the host), reads its transcript, follows the session's status (running, waiting) and the
 * Muse's family stream for that session's messages and for saves of the file (`onSaved`).
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
  // The session's status stream is connected; while it is not, a running turn is polled.
  const [streamUp, setStreamUp] = useState(false);
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

  const read = useCallback(async () => {
    if (!botId || !sessionId) return;
    const page = await rpc.chats.transcript({ botId, chatId: sessionId }).catch(() => null);
    if (!page) return;
    setMessages(page.messages);
    setRunning(page.running === true);
  }, [botId, sessionId]);

  // The session's status: running or not, and `blockedOn` while a turn waits behind the host's
  // studio cap.
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
          setStreamUp(true);
          for await (const frame of frames) {
            if (abort.signal.aborted) return;
            const busy = frame.status === "running";
            setRunning(busy);
            setBlockedOn(busy ? frame.blockedOn : null);
          }
        } catch {
          // Dropped: try again shortly.
        }
        if (abort.signal.aborted) return;
        setStreamUp(false);
        await new Promise((resolve) => setTimeout(resolve, STATUS_RETRY_MS));
      }
    })();
    return () => {
      abort.abort();
      setStreamUp(false);
    };
  }, [botId, sessionId]);

  useEffect(() => {
    void read();
  }, [read]);
  useVisiblePoll(read, CHAT_POLL_MS, !!botId && !!sessionId && running && !streamUp);

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

  const sent = useCallback(() => setRunning(true), []);

  return { sessionId, messages, running, sent, failed, blockedOn };
}
