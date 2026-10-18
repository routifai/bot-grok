import { eventIterator, oc } from "@orpc/contract";
import * as z from "zod";
import { ATTACHMENT_MAX_COUNT, WorkspaceAttachmentSchema } from "../attachments.js";
import { ThreadMessagePageSchema } from "../domain.js";
import { ThreadMessageSchema } from "../events.js";
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
  /** A version of a file was saved (`groupId`: the file, `Artifact.groupId`). */
  z.object({ type: z.literal("artifactsChanged"), groupId: z.string() }),
  z.object({ type: z.literal("heartbeat") }),
]);
export type FamilyEvent = z.infer<typeof FamilyEventSchema>;

/** One chat's status: `blockedOn` is the engine's words while its running turn waits for a slot
 * ("Finishing another file first", ADR 0024), null otherwise. */
export const ChatStatusSchema = z.object({
  status: z.string(),
  blockedOn: z.string().nullable(),
  /** A Helper held by Pause (ADR 0027), as the engine flags it. */
  paused: z.boolean().optional(),
});
export type ChatStatus = z.infer<typeof ChatStatusSchema>;

/** The reply a chat's running turn is writing, as it streams: `text` appends to it (after a
 * (re)connect, the first `text` is everything written so far), `textReset` says it was stored
 * as a message or the turn ended. Display only; whether the turn runs is the transcript's. */
export const ReplyEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), delta: z.string() }),
  z.object({ kind: z.literal("textReset") }),
]);
export type ReplyEvent = z.infer<typeof ReplyEventSchema>;

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
    /** One of the Muse's chats' status as it changes (a file's studio chat). */
    watchStatus: oc
      .input(z.object({ botId: Id, chatId: Id }))
      .output(eventIterator(ChatStatusSchema)),
    /** The reply being written in the Conversation (`chatId` is its id) or one of the Muse's
     * chats, as it streams. */
    watchReply: oc
      .input(z.object({ botId: Id, chatId: Id }))
      .output(eventIterator(ReplyEventSchema)),
    /** Sends the person's message to the Muse's Conversation. Files are already in the
     * workspace (`files.uploadAttachment`); the engine queues or steers a message sent while a
     * turn runs. */
    send: oc
      .input(
        z
          .object({
            botId: Id,
            /** A file's studio chat (`artifacts.chat`) instead of the Conversation (ADR 0024). */
            chatId: Id.optional(),
            text: z.string().optional(),
            attachments: z.array(WorkspaceAttachmentSchema).max(ATTACHMENT_MAX_COUNT).optional(),
            /** Workspace folders (relative, as the Files browser lists them) the message points at. */
            folders: z.array(z.string().max(1024)).max(5).optional(),
            /** What is beside the chat: the artifact open in the panel is a hint for the Muse
             * and the message's `open` link, never a hard scope. */
            context: z
              .object({
                openArtifact: z
                  .object({ artifactId: Id, version: z.number().int().min(1) })
                  .optional(),
                /** The message answers an ask card: which card and option (the text is its label). */
                cardAnswer: z
                  .object({
                    cardId: z.string().min(1).max(200),
                    optionId: z.string().min(1).max(64),
                    label: z.string().min(1).max(200),
                  })
                  .optional(),
                /** The message is about one step of a reply's plan (ADR 0027 "Comment"): the
                 * plan card, the step's place and its words. */
                stepComment: z
                  .object({
                    cardId: z.string().min(1).max(200),
                    stepIndex: z.number().int().min(0).max(49),
                    text: z.string().min(1).max(2000),
                  })
                  .optional(),
              })
              .optional(),
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
    /** The person picks which artifact their message is about (`null`: none). The link becomes
     * `chosen` and a running turn is steered; answers with the updated message. */
    setMessageArtifact: oc
      .input(z.object({ botId: Id, itemId: Id, artifactId: Id.nullable() }))
      .output(ThreadMessageSchema),
    /** Stops the turn running in the Muse's Conversation and its running Helpers; messages waiting
     * behind it are cancelled. `delivered`: whether the stop landed. */
    interrupt: oc
      .input(
        z.object({
          botId: Id,
          /** A file's studio chat instead of the Conversation. */
          chatId: Id.optional(),
        }),
      )
      .output(z.object({ delivered: z.boolean() })),
    /** Holds the newest reply's Helpers at their next tool boundary (ADR 0027); the
     * Conversation's own turn is never paused. A Helper left paused for 30 minutes is stopped.
     * `helperIds` narrows it (default: every live Helper); answers with the Helpers paused. */
    pauseHelpers: oc
      .input(z.object({ botId: Id, helperIds: z.array(Id).optional() }))
      .output(z.object({ paused: z.array(z.string()) })),
    /** Lets paused Helpers go on (default: every paused one); answers with those resumed. */
    resumeHelpers: oc
      .input(z.object({ botId: Id, helperIds: z.array(Id).optional() }))
      .output(z.object({ resumed: z.array(z.string()) })),
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
