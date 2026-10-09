import { eventIterator, oc } from "@orpc/contract";
import * as z from "zod";
import { ThreadMessagePageSchema } from "../domain.js";
import { Id } from "../ids.js";

/**
 * A Side Chat branched from the Super Chat (CONTEXT.md "Side Chat"): a short-lived aside
 * that starts with context (a summary of the Super Chat) or blank (only the Memory
 * Profile). The Super Chat itself never appears in this list; NOVA shows it as the
 * "Conversation" row Side Chats nest under. Served by the Super Chat backend.
 */
export const SideChatStartSchema = z.enum(["withContext", "blank"]);
export type SideChatStart = z.infer<typeof SideChatStartSchema>;
export const ChatSummarySchema = z.object({
  id: Id,
  title: z.string(),
  start: SideChatStartSchema,
  /** The summary it started with; null when it started blank. */
  summary: z.string().nullable(),
  /** Ended and hidden from the default list, but kept and readable (CONTEXT.md "Archived"). */
  archived: z.boolean(),
  /** Whether Nova is currently working in this Side Chat. */
  live: z.boolean(),
  /** The engine's per-person read state: a reply landed that the person has not seen. */
  unread: z.boolean().optional(),
  /** `chats.createSide` only: the chat exists but its first message did not send (the engine's
   * error code); the person resends in it. */
  firstMessageErrorCode: z.string().nullable().optional(),
  /** A Fork (ADR 0010): the message it started from; absent for a plain Side Chat. */
  anchorItemId: z.string().nullable().optional(),
  /** How many forks hang off this chat's messages. */
  forkCount: z.number().int().nonnegative().optional(),
  /** A Fork's own state, its added summary, the chat holding its anchor (the Conversation, or
   * the fork it came from), the anchor's text (cut to ~120 characters) and its reply count. */
  forkState: z.enum(["open", "added", "archived"]).nullable().optional(),
  forkSummary: z.string().nullable().optional(),
  forkParentId: z.string().nullable().optional(),
  anchorSnippet: z.string().nullable().optional(),
  replies: z.number().int().nonnegative().nullable().optional(),
  /** The Project the chat has open (ADR 0008). */
  project: z.object({ slug: z.string(), name: z.string() }).nullable().optional(),
  updatedAt: z.string(),
});
export type ChatSummary = z.infer<typeof ChatSummarySchema>;

/** `chats.createFork` refusals: a fork of a fork of a fork (start a plain Side Chat instead),
 * or an anchor that is not a message of that chat. */
export const FORK_TOO_DEEP = "FORK_TOO_DEEP";
export const FORK_ANCHOR_INVALID = "FORK_ANCHOR_INVALID";

/** One event of a Muse's live family stream (the Conversation, its Side Chats and Helpers).
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

/** Side chats archive themselves after this many days idle; `null` is never. */
export const SIDE_CHAT_ARCHIVE_DAYS = [1, 7, 30] as const;
const ArchiveDaysSchema = z.union([z.literal(1), z.literal(7), z.literal(30)]);
/** The person's effective setting (`null` is never) and what applies if they never choose. */
export const ArchivingSchema = z.object({
  sideChatAutoArchiveDays: ArchiveDaysSchema.nullable(),
  defaultDays: z.number().int().positive(),
});
export type Archiving = z.infer<typeof ArchivingSchema>;
/** `"default"` forgets the choice, so the deployment default applies again. */
export const ArchivingUpdateSchema = z.object({
  sideChatAutoArchiveDays: ArchiveDaysSchema.nullable().or(z.literal("default")),
});
export type ArchivingUpdate = z.infer<typeof ArchivingUpdateSchema>;

export const sideChatsContract = {
  chats: {
    list: oc.input(z.object({ botId: Id })).output(z.array(ChatSummarySchema)),
    /** Creates the Side Chat and sends its first message atomically. */
    createSide: oc
      .input(z.object({ botId: Id, start: SideChatStartSchema, text: z.string().min(1) }))
      .output(ChatSummarySchema),
    /** Opens a Fork of one message (ADR 0010) and sends its first message. `chatId` is the chat
     * holding the anchor (absent: the Conversation; a fork, for a fork of a fork). Refusals are
     * `FORK_TOO_DEEP` and `FORK_ANCHOR_INVALID` (422). */
    createFork: oc
      .input(
        z.object({
          botId: Id,
          chatId: Id.optional(),
          anchorItemId: z.string().min(1),
          text: z.string().min(1),
        }),
      )
      .output(ChatSummarySchema),
    /** Adds the Fork's one-line summary back under its anchor (the engine writes it when
     * `summary` is absent). */
    addToConversation: oc
      .input(z.object({ botId: Id, chatId: Id, summary: z.string().min(1).optional() }))
      .output(z.object({ summary: z.string() })),
    /** Archives a Side Chat or Fork (CONTEXT.md "Archived"); writing in it brings it back. */
    archive: oc
      .input(z.object({ botId: Id, chatId: Id }))
      .output(z.object({ ok: z.literal(true) })),
    /** Restores an archived Side Chat or Fork: writable again and listed with the open ones. */
    unarchive: oc
      .input(z.object({ botId: Id, chatId: Id }))
      .output(z.object({ ok: z.literal(true) })),
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
    /** Side Chats archive themselves after the chosen days idle (`null`: never). */
    archiving: oc.input(z.object({ botId: Id })).output(ArchivingSchema),
    updateArchiving: oc
      .input(ArchivingUpdateSchema.safeExtend({ botId: Id }))
      .output(ArchivingSchema),
    /** The Project a chat is working in (its working directory is a Project folder), or null.
     * Without `chatId`, the Conversation itself. */
    project: oc
      .input(z.object({ botId: Id, chatId: Id.optional() }))
      .output(z.object({ project: z.object({ slug: z.string(), name: z.string() }).nullable() })),
  },
};
