import type { ChatSummary, SideChatStart } from "@aiden/contracts";
import { ORPCError } from "@orpc/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { rpc } from "../../../lib/rpc";

/** The Chat List wire: a Muse's Side Chats, or why they can't be shown. */
export type ChatListState =
  | { status: "loading" }
  | { status: "ready"; chats: ChatSummary[] }
  | { status: "unavailable" }
  | { status: "error" };

/** How often the sidebar refreshes the list, so a chat started elsewhere (or one Nova
 * just finished working in) shows up without a reload. */
const REFRESH_INTERVAL_MS = 15_000;

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

  useEffect(() => {
    load();
    const timer = window.setInterval(load, REFRESH_INTERVAL_MS);
    return () => {
      generation.current += 1;
      window.clearInterval(timer);
    };
  }, [load]);

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
