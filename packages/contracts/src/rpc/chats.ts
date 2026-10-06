import { oc } from "@orpc/contract";
import * as z from "zod";
import { ThreadMessagePageSchema } from "../domain.js";
import { Id } from "../ids.js";
import { ChatSummarySchema, SideChatStartSchema } from "../muse.js";

export const chatsContract = {
  chats: {
    list: oc.input(z.object({ botId: Id })).output(z.array(ChatSummarySchema)),
    /** Creates the Side Chat and sends its first message atomically. */
    createSide: oc
      .input(z.object({ botId: Id, start: SideChatStartSchema, text: z.string().min(1) }))
      .output(ChatSummarySchema),
    /** The summary a new Side Chat would start with, for the "Knows our conversation" switch. */
    summaryPreview: oc.input(z.object({ botId: Id })).output(z.object({ summary: z.string() })),
    /** Newest page by default; pass `before` (an `olderItemCursor` from a previous page) to
     * page further back. */
    messages: oc
      .input(z.object({ chatId: Id, before: z.string().min(1).optional() }))
      .output(ThreadMessagePageSchema),
    send: oc
      .input(z.object({ chatId: Id, text: z.string().min(1) }))
      .output(z.object({ ok: z.literal(true) })),
    /** The Project a chat is working in (its working directory is a Project folder), or null.
     * Without `chatId`, the Conversation itself. */
    project: oc
      .input(z.object({ botId: Id, chatId: Id.optional() }))
      .output(z.object({ project: z.object({ slug: z.string(), name: z.string() }).nullable() })),
  },
  // Muse edition. Goals are created by talking to the Muse, so there is no goals.create.
};
