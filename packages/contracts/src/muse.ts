import * as z from "zod";
import { Id } from "./ids.js";

// Shapes for the Muse edition. Words follow CONTEXT.md: Goal, Task (GoalTask in code),
// Proposal, Ask, Post, Followed topic, Idea, Proactivity.

export const GoalStatusSchema = z.enum(["active", "paused", "done", "cancelled"]);
export type GoalStatus = z.infer<typeof GoalStatusSchema>;

export const GoalTaskStatusSchema = z.enum([
  "pending",
  "in_progress",
  "done",
  "blocked",
  "skipped",
]);
export type GoalTaskStatus = z.infer<typeof GoalTaskStatusSchema>;

export const GoalTaskSchema = z.object({
  id: Id,
  goalId: Id,
  idx: z.number().int().nonnegative(),
  title: z.string(),
  status: GoalTaskStatusSchema,
  note: z.string(),
  updatedAt: z.string(),
});
export type GoalTask = z.infer<typeof GoalTaskSchema>;

export const GoalProposalStatusSchema = z.enum(["open", "accepted", "dismissed", "withdrawn"]);
export type GoalProposalStatus = z.infer<typeof GoalProposalStatusSchema>;

/**
 * One task in a proposed plan. `keepTaskId` marks a task carried over unchanged from
 * the Goal's current plan, so the Goals screen can diff by identity instead of title.
 */
export const GoalProposalTaskSchema = z.object({
  title: z.string().min(1).max(200),
  keepTaskId: Id.optional(),
});
export type GoalProposalTask = z.infer<typeof GoalProposalTaskSchema>;

/** A plan change the Muse suggests. `tasks` is the full proposed plan, in order. */
export const GoalProposalSchema = z.object({
  id: Id,
  goalId: Id,
  reason: z.string(),
  tasks: z.array(GoalProposalTaskSchema).min(1),
  status: GoalProposalStatusSchema,
  createdAt: z.string(),
});
export type GoalProposal = z.infer<typeof GoalProposalSchema>;

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

export const GoalSchema = z.object({
  id: Id,
  botId: Id,
  title: z.string(),
  description: z.string(),
  status: GoalStatusSchema,
  /** Calendar date, YYYY-MM-DD. */
  due: z.string().nullable(),
  /** Check-in schedule in the same cron shape as routines; empty means no check-ins. */
  checkInCrons: z.array(z.string()),
  timezone: z.string(),
  tasks: z.array(GoalTaskSchema),
  openProposal: GoalProposalSchema.nullable(),
  lastWorkedAt: z.string().nullable(),
  nextWorkAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Goal = z.infer<typeof GoalSchema>;

export const UpdateGoalInput = z.object({
  goalId: Id,
  status: z.enum(["active", "paused", "cancelled"]).optional(),
  checkInCrons: z.array(z.string()).max(8).optional(),
  timezone: z.string().optional(),
});

export const AskKindSchema = z.enum([
  "approval",
  "question",
  "proposal",
  "blocked_task",
  "skill_offer",
]);
export type AskKind = z.infer<typeof AskKindSchema>;

/**
 * Something the Muse is waiting on the person for. A view over a pending ask or choice
 * block in the Conversation or a Goal log; the message block stays the source of truth.
 */
export const AskSchema = z.object({
  /** The message that holds the block. */
  id: Id,
  runId: Id,
  kind: AskKindSchema,
  goalId: Id.nullable(),
  goalTitle: z.string().nullable(),
  text: z.string(),
  detail: z.string().optional(),
  /** Tappable answers; the answer sent back is the choice id. */
  choices: z.array(z.object({ id: z.string(), label: z.string() })),
  /** Free-form answer field when set; otherwise answer with a choice. */
  input: z.enum(["text", "secret"]).nullable(),
  createdAt: z.string(),
  /** Set on an approval the engine is holding for the person: the Side Chat it belongs to,
   * `null` for the Conversation (and its Helpers). */
  approval: z.object({ chatId: Id.nullable() }).optional(),
});
export type Ask = z.infer<typeof AskSchema>;

/** A standing approval rule, as Settings lists it. */
export const ApprovalStandingRuleSchema = z.object({
  id: Id,
  label: z.string(),
  decision: z.enum(["allow", "deny"]),
  createdAt: z.number(),
});
export type ApprovalStandingRule = z.infer<typeof ApprovalStandingRuleSchema>;

/** The daily spending cap in USD (0 = always ask) and what has gone through today. */
export const ApprovalSpendingSchema = z.object({
  dailyCapUsd: z.number().min(0),
  spentTodayUsd: z.number().min(0),
});
export type ApprovalSpending = z.infer<typeof ApprovalSpendingSchema>;

export const AnswerAskInput = z.object({
  askId: Id,
  runId: Id,
  answer: z.string().min(1),
  /** Only for a login card; `answer` carries its password. */
  username: z.string().optional(),
});

export const PostKindSchema = z.enum(["goal_report", "topic"]);
export type PostKind = z.infer<typeof PostKindSchema>;

/** One Feed item. Links back to its Goal log, its web source, or a Library artifact. */
export const PostSchema = z.object({
  id: Id,
  kind: PostKindSchema,
  title: z.string(),
  body: z.string(),
  goalId: Id.nullable(),
  sourceUrl: z.string().url().nullable(),
  /** Optional link to a Library artifact this Post is about. */
  artifactId: Id.nullable().optional(),
  createdAt: z.string(),
});
export type Post = z.infer<typeof PostSchema>;

export const FeedSchema = z.object({
  asks: z.array(AskSchema),
  posts: z.array(PostSchema),
  nextCursor: z.string().nullable(),
});
export type Feed = z.infer<typeof FeedSchema>;

export const FollowedTopicSchema = z.object({
  id: Id,
  topic: z.string(),
  createdAt: z.string(),
  /** How often the topic is checked; absent means daily. */
  cadence: z.enum(["hourly", "daily", "weekly"]).optional(),
});
export type FollowedTopic = z.infer<typeof FollowedTopicSchema>;

/**
 * Keys for the Muse edition's bundled 3D illustrations (Microsoft Fluent Emoji, MIT;
 * see NOTICE). One source of truth for the backend (Idea prompt/parser) and the web
 * client (apps/web/src/lib/illustrations.ts), which resolves each key to its PNG.
 */
export const ILLUSTRATION_KEYS = [
  "bank",
  "briefcase",
  "chart-increasing",
  "bar-chart",
  "money-bag",
  "coin",
  "credit-card",
  "dollar-banknote",
  "light-bulb",
  "spiral-calendar",
  "spiral-notepad",
  "clipboard",
  "books",
  "graduation-cap",
  "magnifying-glass",
  "envelope",
  "handshake",
  "laptop",
  "globe",
  "newspaper",
  "bell",
  "trophy",
  "rocket",
  "shield",
  "speech-balloon",
  "house",
] as const;
export const IllustrationKeySchema = z.enum(ILLUSTRATION_KEYS);
export type IllustrationKey = z.infer<typeof IllustrationKeySchema>;

export const IdeaSchema = z.object({
  id: Id,
  /** Short first-person title ("I can keep your $1M goal on a monthly pace"). */
  text: z.string(),
  /** Short grouping label, e.g. "learning" or "travel". */
  area: z.string(),
  /** 1-3 sentence explanation of concretely what the Muse would do. */
  detail: z.string().nullable().optional(),
  /** Illustration for this Idea's row; falls back to an area-keyed default. */
  illustration: IllustrationKeySchema.nullable().optional(),
  createdAt: z.string(),
});
export type Idea = z.infer<typeof IdeaSchema>;

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
