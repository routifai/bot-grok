import type { ChatSummary, SideChatStart } from "@aiden/contracts";
import { ORPCError } from "@orpc/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { rpc } from "../../../lib/rpc";

/** The Chat List wire: the Super Chat and its Side Chats, or why they can't be shown. */
export type ChatListState =
  | { status: "loading" }
  | { status: "ready"; chats: ChatSummary[] }
  | { status: "unavailable" }
  | { status: "error" };

const isUnavailable = (error: unknown) =>
  error instanceof ORPCError && error.code === "NOT_IMPLEMENTED";

export function useChatList(botId: string) {
  const [state, setState] = useState<ChatListState>({ status: "loading" });
  const generation = useRef(0);

  const load = useCallback(() => {
    const current = ++generation.current;
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
    return () => {
      generation.current += 1;
    };
  }, [load]);

  const createSide = useCallback(
    async (start: SideChatStart) => {
      const chat = await rpc.chats.createSide({ botId, start });
      load();
      return chat;
    },
    [botId, load],
  );

  return { state, createSide };
}
