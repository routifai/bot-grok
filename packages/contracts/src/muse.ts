import * as z from "zod";
import { Id } from "./ids.js";

// Shapes for the Muse edition. Words follow CONTEXT.md: Goal, Task (GoalTask in code),
// Proposal, Ask, Post, Followed topic, Idea, Proactivity.

export const PRODUCT_MODES = ["rakazo", "muse"] as const;
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

export const GoalProposalStatusSchema = z.enum(["open", "accepted", "dismissed"]);
export type GoalProposalStatus = z.infer<typeof GoalProposalStatusSchema>;

/** A plan change the Muse suggests. `tasks` is the full proposed plan, in order. */
export const GoalProposalSchema = z.object({
  id: Id,
  goalId: Id,
  reason: z.string(),
  tasks: z.array(z.object({ title: z.string().min(1).max(200) })).min(1),
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

/** One Feed item. Links back to its Goal log or its web source. */
export const PostSchema = z.object({
  id: Id,
  kind: PostKindSchema,
  title: z.string(),
  body: z.string(),
  goalId: Id.nullable(),
  sourceUrl: z.string().url().nullable(),
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

/** What the Muse's face shows: resting, working, or waiting on the person. */
export const MuseStateSchema = z.enum(["idle", "working", "waiting"]);
export type MuseState = z.infer<typeof MuseStateSchema>;
