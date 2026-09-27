import * as z from "zod";
import { Id } from "./ids.js";

// Shapes for the Muse edition. Words follow CONTEXT.md: Goal, Task (GoalTask in code),
// Proposal, Ask, Post, Followed topic, Idea, Proactivity.

export const PRODUCT_MODES = ["aiden", "muse"] as const;
export const ProductModeSchema = z.enum(PRODUCT_MODES);
export type ProductMode = z.infer<typeof ProductModeSchema>;

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

export const AskKindSchema = z.enum(["approval", "question", "proposal", "blocked_task"]);
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
});
export type Ask = z.infer<typeof AskSchema>;

export const AnswerAskInput = z.object({
  askId: Id,
  runId: Id,
  answer: z.string().min(1),
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
  artifactId: Id.nullable(),
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
});
export type FollowedTopic = z.infer<typeof FollowedTopicSchema>;

export const IdeaSchema = z.object({
  id: Id,
  text: z.string(),
  /** Short grouping label, e.g. "learning" or "travel". */
  area: z.string(),
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
export const DEFAULT_MUSE_NAME = "Aiden";

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
