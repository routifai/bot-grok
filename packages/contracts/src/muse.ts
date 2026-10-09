import * as z from "zod";
import { Id } from "./ids.js";

// Shapes shared by the Muse edition: Side Chats and the family stream (until side-chats gets its
// own rpc file), Proactivity and Muse settings, archiving, the Muse's state and its starting
// profile. Words follow CONTEXT.md. The Goal, Ask, Approval, Post, Followed topic and Idea
// shapes live in rpc/<capability>.ts and are re-exported from the package index.

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

export const PROACTIVITY_LEVELS = ["off", "low", "normal", "high"] as const;
export const ProactivitySchema = z.enum(PROACTIVITY_LEVELS);
export type Proactivity = z.infer<typeof ProactivitySchema>;

/** Local-time window with no background work, "HH:MM-HH:MM"; may wrap midnight. */
export const QuietHoursSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/);

export const MuseSettingsSchema = z.object({
  proactivity: ProactivitySchema,
  quietHours: QuietHoursSchema.nullable(),
});
export type MuseSettings = z.infer<typeof MuseSettingsSchema>;

export const DEFAULT_MUSE_SETTINGS: MuseSettings = {
  proactivity: "normal",
  quietHours: "22:00-08:00",
};

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

/** Default identity color of a new Muse (sky). */
export const DEFAULT_MUSE_COLOR = "#0090FF";

/** Default name of a new Muse. */
export const DEFAULT_MUSE_NAME = "Nova";

/** What the Muse's face shows: resting, thinking, working, or waiting on the person. */
export const MuseStateSchema = z.enum(["idle", "thinking", "working", "waiting"]);
export type MuseState = z.infer<typeof MuseStateSchema>;

/**
 * The profile a new Muse is created with, so it knows who it is from the first message
 * instead of reporting a blank role.
 */
export function museBotProfile(museName: string, personName: string) {
  const person = personName.trim() || "the person you work for";
  return {
    title: "AI teammate",
    description: `${person}'s AI teammate — already on it.`,
    instructions: [
      `You are ${museName}, ${person}'s AI teammate. They work at a bank, and you work alongside them on their everyday work.`,
      "Prepare meetings and briefings, research and pull the numbers, draft emails and documents, track follow-ups, and keep their Goals moving — in the background, without being asked.",
      "Be proactive: when you see the next useful step, take it or offer it. Ask before anything that can't be undone, such as sending, submitting, booking, or paying.",
      "Write plainly and briefly, in the first person. Never invent figures; say where numbers come from. Do not give personal investment advice.",
    ].join("\n"),
  };
}
