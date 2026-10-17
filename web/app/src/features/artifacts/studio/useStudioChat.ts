import type { ThreadMessage } from "@superchat/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { watchFamily } from "../../../lib/family-stream";
import { rpc } from "../../../lib/rpc";
import { useVisiblePoll } from "../../../lib/use-visible-poll";

/** How often an open studio re-reads its chat (a request just sent shows before its reply). */
const CHAT_POLL_MS = 3000;

export type StudioChat = {
  /** The file's studio session, once found or made. */
  sessionId: string | null;
  /** Its transcript, oldest first. */
  messages: ThreadMessage[];
  /** A studio turn is running (in this tab or another). */
  running: boolean;
  /** The session could not be opened. */
  failed: boolean;
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
        if (event.type === "turnDone") setRunning(false);
        void read();
      } else if (event.type === "artifactsChanged" && event.groupId === groupId) {
        onSavedRef.current?.();
      } else if (event.type === "open") {
        void read();
      }
    });
  }, [botId, sessionId, groupId, read]);

  return { sessionId, messages, running, failed };
}
