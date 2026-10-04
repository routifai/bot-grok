import type { ThreadMessage } from "@aiden/contracts";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { type ResolvedReplyCard, replyCardKey, resolveReplyCards } from "./thread";

/** How a card talks back: the person's next message, through the thread's own send path. */
const SendContext = createContext<((text: string) => void) | null>(null);
const ThreadContext = createContext<Map<string, ResolvedReplyCard> | null>(null);

export function ReplyCardSendProvider({
  send,
  children,
}: {
  send: (text: string) => void;
  children: ReactNode;
}) {
  return <SendContext.Provider value={send}>{children}</SendContext.Provider>;
}

/** Wrap a transcript once; its cards then update in place and lock once answered. */
export function ReplyCardThreadProvider({
  messages,
  children,
}: {
  messages: readonly ThreadMessage[];
  children: ReactNode;
}) {
  const resolved = useMemo(() => resolveReplyCards(messages), [messages]);
  return <ThreadContext.Provider value={resolved}>{children}</ThreadContext.Provider>;
}

/** The Muse whose chat this is; cards that talk to the API on the person's behalf need it. */
const BotIdContext = createContext<string | null>(null);

export function ReplyCardBotProvider({
  botId,
  children,
}: {
  botId: string | undefined;
  children: ReactNode;
}) {
  return <BotIdContext.Provider value={botId || null}>{children}</BotIdContext.Provider>;
}

export const useReplyCardBotId = () => useContext(BotIdContext);

export const useReplyCardSend = () => useContext(SendContext);

export function useResolvedReplyCard(
  messageId: string,
  blockIndex: number,
): ResolvedReplyCard | undefined {
  return useContext(ThreadContext)?.get(replyCardKey(messageId, blockIndex));
}
