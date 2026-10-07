import type { FamilyEvent, ProductEvent } from "@aiden/contracts";

type Notification = Pick<ProductEvent, "id" | "type" | "threadId" | "seq" | "botId" | "payload">;

export interface ReplyAlertDeps {
  botId: string;
  botName: string;
  /** The Muse's "notify when it finishes" setting. */
  enabled: boolean;
  /** The Conversation's id (a reply there marks the Muse unread); `null` until it is read. */
  conversationId: string | null;
  /** The person is looking at the app right now. */
  focused: () => boolean;
  /** The text of the reply, for the notification body; empty when it cannot be read. */
  readText: (chatId: string, itemId: string) => Promise<string>;
  markUnread: () => Promise<void>;
  notify: (event: Notification, botName: string, enabled: boolean) => void;
}

/**
 * A reply landed in the Conversation or a Side Chat (`messageDone` on the family stream):
 * unless the person is looking, mark the Muse unread (Conversation only) and raise the browser
 * notification, under the same rules as before (`shouldNotifyBrowser`: permission, once per
 * message, not while the window is focused).
 */
export async function alertForReply(event: FamilyEvent, deps: ReplyAlertDeps): Promise<void> {
  if (event.type !== "messageDone" || deps.focused()) return;
  if (event.chatId === deps.conversationId) await deps.markUnread().catch(() => undefined);
  const text = await deps.readText(event.chatId, event.itemId).catch(() => "");
  deps.notify(
    {
      id: `${event.chatId}:${event.itemId}`,
      type: "thread.message.created",
      threadId: event.chatId,
      seq: 1,
      botId: deps.botId,
      payload: { role: "bot", blocks: text ? [{ kind: "text", text }] : [] },
    },
    deps.botName,
    deps.enabled,
  );
}
