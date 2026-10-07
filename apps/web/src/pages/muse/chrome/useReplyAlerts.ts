import type { Bot, ProductEvent } from "@aiden/contracts";
import { useEffect, useRef } from "react";
import { watchFamily } from "../../../lib/family-stream";
import { rpc } from "../../../lib/rpc";
import { alertForReply } from "./replyAlerts";

type Notify = (
  event: Pick<ProductEvent, "id" | "type" | "threadId" | "seq" | "botId" | "payload">,
  subscribedThreadId: string | undefined,
  initialCursor: number,
  streamReady: boolean,
  botName: string,
  enabled: boolean,
  groupNotification: boolean,
) => void;

/** Unread dot and browser notification for the Muse's replies, driven by the family stream
 * because the reply is no longer a Nova thread row that raises them itself. */
export function useReplyAlerts({
  bot,
  conversationId,
  notifyBrowserForEvent,
  refreshBots,
}: {
  bot: Bot | undefined;
  conversationId: string | null;
  notifyBrowserForEvent: Notify;
  refreshBots: () => Promise<void>;
}) {
  const latest = useRef({ bot, conversationId, notifyBrowserForEvent, refreshBots });
  latest.current = { bot, conversationId, notifyBrowserForEvent, refreshBots };
  const botId = bot?.id;
  useEffect(() => {
    if (!botId) return;
    return watchFamily(botId, (event) => {
      const { bot, conversationId, notifyBrowserForEvent, refreshBots } = latest.current;
      if (!bot) return;
      void alertForReply(event, {
        botId: bot.id,
        botName: bot.name,
        enabled: bot.notifyOnFinish,
        conversationId,
        focused: () => document.visibilityState === "visible" && document.hasFocus(),
        readText: async (chatId, itemId) => {
          const page = await rpc.chats.transcript({
            botId: bot.id,
            ...(chatId === conversationId ? {} : { chatId }),
          });
          const reply = page.messages.find((message) => message.id === itemId);
          return (reply?.blocks ?? [])
            .map((block) => (block.kind === "text" ? block.text : ""))
            .filter(Boolean)
            .join("\n");
        },
        markUnread: async () => {
          await rpc.threads.markUnread({ botId: bot.id });
          await refreshBots();
        },
        notify: (notification, name, enabled) =>
          notifyBrowserForEvent(notification, notification.threadId, 0, true, name, enabled, false),
      });
    });
  }, [botId]);
}
