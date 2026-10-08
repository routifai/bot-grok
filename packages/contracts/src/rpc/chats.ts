import { eventIterator, oc } from "@orpc/contract";
import * as z from "zod";
import { ThreadMessagePageSchema } from "../domain.js";
import { Id } from "../ids.js";
import { ChatSummarySchema, FamilyEventSchema, SideChatStartSchema } from "../muse.js";

export const chatsContract = {
  chats: {
    list: oc.input(z.object({ botId: Id })).output(z.array(ChatSummarySchema)),
    /** Creates the Side Chat and sends its first message atomically. */
    createSide: oc
      .input(z.object({ botId: Id, start: SideChatStartSchema, text: z.string().min(1) }))
      .output(ChatSummarySchema),
    /** The summary a new Side Chat would start with, for the "Knows our conversation" switch. */
    summaryPreview: oc.input(z.object({ botId: Id })).output(z.object({ summary: z.string() })),
    /** The Conversation (no `chatId`), one of its Side Chats, or a Helper, as typed blocks.
     * Newest page by default; pass `before` (an `olderItemCursor` from a previous page) to page
     * further back. */
    transcript: oc
      .input(
        z.object({
          botId: Id,
          chatId: Id.optional(),
          before: z.string().min(1).optional(),
          /** Read the history older than the chat's latest reset instead. */
          beforeReset: z.boolean().optional(),
        }),
      )
      .output(ThreadMessagePageSchema),
    /** The person has the chat open: marks it read (and clears its unread dot). */
    markRead: oc
      .input(z.object({ botId: Id, chatId: Id.optional() }))
      .output(z.object({ ok: z.literal(true) })),
    /** Clears the Muse's Conversation (CONFLICT while a turn is running). */
    reset: oc.input(z.object({ botId: Id })).output(z.object({ ok: z.literal(true) })),
    /** The Muse's live family stream: ids only, refetch what changed. */
    watch: oc.input(z.object({ botId: Id })).output(eventIterator(FamilyEventSchema)),
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
