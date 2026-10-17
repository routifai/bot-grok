import { eventIterator, oc } from "@orpc/contract";
import * as z from "zod";
import { ATTACHMENT_MAX_COUNT, WorkspaceAttachmentSchema } from "../attachments.js";
import { ThreadMessagePageSchema } from "../domain.js";
import { Id } from "../ids.js";

/** One event of a Muse's live family stream (the Conversation and its Helpers).
 * Ids only: the client refetches what changed. `open` is local to the relay: the stream just
 * (re)connected, so anything may have been missed. */
export const FamilyEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("open") }),
  z.object({ type: z.literal("messageDone"), chatId: z.string(), itemId: z.string() }),
  /** A message the person sent during a turn started or stopped waiting behind it; its
   * transcript message says which (`delivered: "queued"` while it waits). */
  z.object({ type: z.literal("messageDelivery"), chatId: z.string(), itemId: z.string() }),
  /** A turn in this chat ended (completed, failed, incomplete or cancelled); a failure's
   * error note is already in the transcript. */
  z.object({ type: z.literal("turnDone"), chatId: z.string(), status: z.string() }),
  /** The chat was cleared; its transcript now starts at the reset. */
  z.object({ type: z.literal("chatReset"), chatId: z.string(), itemId: z.string() }),
  z.object({ type: z.literal("chatsChanged") }),
  z.object({ type: z.literal("activitiesChanged") }),
  z.object({ type: z.literal("heartbeat") }),
]);
export type FamilyEvent = z.infer<typeof FamilyEventSchema>;

export const chatsContract = {
  chats: {
    /** The Conversation (no `chatId`) or one of its Helpers, as typed blocks.
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
    /** The person has the Conversation open: marks it read (and clears its unread dot). */
    markRead: oc.input(z.object({ botId: Id })).output(z.object({ ok: z.literal(true) })),
    /** Clears the Muse's Conversation (CONFLICT while a turn is running). */
    reset: oc.input(z.object({ botId: Id })).output(z.object({ ok: z.literal(true) })),
    /** The Muse's live family stream: ids only, refetch what changed. */
    watch: oc.input(z.object({ botId: Id })).output(eventIterator(FamilyEventSchema)),
    /** Sends the person's message to the Muse's Conversation. Files are already in the
     * workspace (`files.uploadAttachment`); the engine queues or steers a message sent while a
     * turn runs. */
    send: oc
      .input(
        z
          .object({
            botId: Id,
            text: z.string().optional(),
            attachments: z.array(WorkspaceAttachmentSchema).max(ATTACHMENT_MAX_COUNT).optional(),
            /** Workspace folders (relative, as the Files browser lists them) the message points at. */
            folders: z.array(z.string().max(1024)).max(5).optional(),
          })
          .refine(
            (input) =>
              (input.text?.trim() ?? "") ||
              (input.attachments?.length ?? 0) > 0 ||
              (input.folders?.length ?? 0) > 0,
            "Write a message or attach something",
          ),
      )
      .output(z.object({ ok: z.literal(true) })),
    /** Stops the turn running in the Muse's Conversation; messages waiting behind it are cancelled. */
    interrupt: oc.input(z.object({ botId: Id })).output(z.object({ ok: z.literal(true) })),
    /** Where the Conversation works: its Project (its working directory is a Project folder) or
     * null, the folder relative to the workspace (null: the whole workspace) and whether the
     * person chose it. */
    project: oc.input(z.object({ botId: Id })).output(
      z.object({
        project: z.object({ slug: z.string(), name: z.string() }).nullable(),
        folder: z.string().nullable().optional(),
        chosen: z.boolean().optional(),
      }),
    ),
    /** The person moves the Conversation to a workspace folder, relative as the Files browser
     * lists it; `null` is the whole workspace and clears their choice. The Muse keeps a folder
     * the person chose and is told of the move once. */
    setFolder: oc
      .input(z.object({ botId: Id, folder: z.string().max(1024).nullable() }))
      .output(z.object({ ok: z.literal(true) })),
  },
};
