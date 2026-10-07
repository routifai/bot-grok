import type { ThreadMessage } from "@aiden/contracts";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { watchFamily } from "../../../lib/family-stream";
import { rpc } from "../../../lib/rpc";
import { mergeNewestTranscriptPage } from "./museTranscript";

/** Events arrive in bursts (a reply, a Helper starting): read the page once per burst. */
const REFRESH_THROTTLE_MS = 150;
/** How far back a search jump may page (50 messages a page). */
const MAX_REVEAL_PAGES = 40;

type Loaded = { threadId: string; messages: ThreadMessage[]; olderCursor: string | null };

/**
 * The Muse's Conversation, read from the engine's transcript (ADR 0009) and refreshed on its
 * family stream: when a reply lands (`messageDone` for this Conversation), when a Side Chat or
 * Helper starts (`chatsChanged`), and after a reconnect. `refresh()` is for the caller's own
 * moments the stream has no event for (the person's send being recorded).
 */
export function useMuseTranscript(
  botId: string | undefined,
  scrollRef: RefObject<HTMLElement | null>,
) {
  const [loaded, setLoaded] = useState<(Loaded & { botId: string }) | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const loadedRef = useRef<(Loaded & { botId: string }) | null>(null);
  const generation = useRef(0);
  const throttle = useRef<number | undefined>(undefined);
  const firstRead = useRef<Promise<void>>(Promise.resolve());

  const commit = useCallback((next: (Loaded & { botId: string }) | null) => {
    loadedRef.current = next;
    setLoaded(next);
  }, []);

  const read = useCallback(async () => {
    if (!botId) return;
    const current = generation.current;
    try {
      const page = await rpc.chats.transcript({ botId });
      if (current !== generation.current) return;
      const prev = loadedRef.current?.botId === botId ? loadedRef.current : null;
      commit({ botId, ...mergeNewestTranscriptPage(prev, page) });
    } catch {
      // Keep what is shown; the next event or send reads again. A Muse with no Conversation
      // yet simply shows none.
      if (current === generation.current && !loadedRef.current) {
        commit({ botId, threadId: "", messages: [], olderCursor: null });
      }
    }
  }, [botId, commit]);

  const refresh = useCallback(() => {
    if (throttle.current !== undefined) return;
    throttle.current = window.setTimeout(() => {
      throttle.current = undefined;
      void read();
    }, REFRESH_THROTTLE_MS);
  }, [read]);

  useEffect(() => {
    generation.current += 1;
    commit(null);
    if (!botId) return;
    firstRead.current = read();
    let connected = false;
    const stop = watchFamily(botId, (event) => {
      if (event.type === "messageDone" || event.type === "turnDone") {
        if (event.chatId === loadedRef.current?.threadId) refresh();
      } else if (event.type === "chatsChanged") {
        refresh();
      } else if (event.type === "open") {
        if (connected) refresh();
        connected = true;
      }
    });
    return () => {
      generation.current += 1;
      window.clearTimeout(throttle.current);
      throttle.current = undefined;
      stop();
    };
  }, [botId, commit, read, refresh]);

  const loadOlder = useCallback(async () => {
    const current = loadedRef.current;
    if (!botId || !current || current.botId !== botId || !current.olderCursor || loadingOlder) {
      return;
    }
    const element = scrollRef.current;
    const previousHeight = element?.scrollHeight ?? 0;
    const epoch = generation.current;
    setLoadingOlder(true);
    try {
      const page = await rpc.chats.transcript({ botId, before: current.olderCursor });
      const latest = loadedRef.current;
      if (epoch !== generation.current || !latest) return;
      commit({
        ...latest,
        messages: [...page.messages, ...latest.messages],
        olderCursor: page.olderItemCursor ?? null,
      });
      window.requestAnimationFrame(() => {
        const next = scrollRef.current;
        if (next) next.scrollTop += next.scrollHeight - previousHeight;
      });
    } finally {
      setLoadingOlder(false);
    }
  }, [botId, commit, loadingOlder, scrollRef]);

  /** Pages back until the message is loaded (a search hit can be far up); false if it is not
   * in the Conversation. */
  const reveal = useCallback(
    async (messageId: string): Promise<boolean> => {
      await firstRead.current;
      const epoch = generation.current;
      for (let pages = 0; pages < MAX_REVEAL_PAGES; pages += 1) {
        const current = loadedRef.current;
        if (!botId || !current || current.botId !== botId) return false;
        if (current.messages.some((message) => message.id === messageId)) return true;
        if (!current.olderCursor) return false;
        const page = await rpc.chats.transcript({ botId, before: current.olderCursor });
        const latest = loadedRef.current;
        if (epoch !== generation.current || !latest) return false;
        commit({
          ...latest,
          messages: [...page.messages, ...latest.messages],
          olderCursor: page.olderItemCursor ?? null,
        });
      }
      return false;
    },
    [botId, commit],
  );

  const forBot = loaded?.botId === botId ? loaded : null;
  return {
    /** `null` until the first page has been read. */
    messages: forBot?.messages ?? null,
    /** The Conversation's engine id, or `null` until it is read. */
    threadId: forBot?.threadId || null,
    /** The cursor of the next older page, or `null` when this is the start. */
    olderCursor: forBot?.olderCursor ?? null,
    loadingOlder,
    loadOlder,
    reveal,
    refresh,
  };
}
