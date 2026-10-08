import type { ChatSummary, SideChatStart } from "@nova/contracts";
import { ORPCError } from "@orpc/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { watchFamily } from "../../../lib/family-stream";
import { rpc } from "../../../lib/rpc";

/** The Chat List wire: a Muse's Side Chats, or why they can't be shown. */
export type ChatListState =
  | { status: "loading" }
  | { status: "ready"; chats: ChatSummary[] }
  | { status: "unavailable" }
  | { status: "error" };

/** Events arrive in bursts (a rename, a Helper start, a reply): read the list once per burst. */
const REFRESH_THROTTLE_MS = 150;

const isUnavailable = (error: unknown) =>
  error instanceof ORPCError && error.code === "NOT_IMPLEMENTED";

export function useChatList(botId: string) {
  const [state, setState] = useState<ChatListState>({ status: "loading" });
  const generation = useRef(0);

  const load = useCallback(() => {
    const current = ++generation.current;
    // The bot id is empty until the Muse resolves; the API rejects "" with a 400.
    if (!botId) return;
    rpc.chats
      .list({ botId })
      .then((chats) => {
        if (current === generation.current) setState({ status: "ready", chats });
      })
      .catch((error: unknown) => {
        if (current === generation.current)
          setState({ status: isUnavailable(error) ? "unavailable" : "error" });
      });
  }, [botId]);

  // The list follows the engine's family stream: a chat opened, renamed or archived, a Helper
  // started, or a reply finished (its live dot and order). A reconnect re-reads what was missed.
  useEffect(() => {
    load();
    if (!botId) return;
    let timer: number | undefined;
    let connected = false;
    const refresh = () => {
      if (timer !== undefined) return;
      timer = window.setTimeout(() => {
        timer = undefined;
        load();
      }, REFRESH_THROTTLE_MS);
    };
    const stop = watchFamily(botId, (event) => {
      if (
        event.type === "chatsChanged" ||
        event.type === "messageDone" ||
        event.type === "turnDone"
      )
        refresh();
      else if (event.type === "open") {
        if (connected) refresh();
        connected = true;
      }
    });
    return () => {
      generation.current += 1;
      window.clearTimeout(timer);
      stop();
    };
  }, [botId, load]);

  /** Creates a Side Chat and sends its first message atomically, then refreshes the list. */
  const createSide = useCallback(
    async (start: SideChatStart, text: string) => {
      const chat = await rpc.chats.createSide({ botId, start, text });
      load();
      return chat;
    },
    [botId, load],
  );

  return { state, createSide, refresh: load };
}
