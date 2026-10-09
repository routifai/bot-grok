import { oc } from "@orpc/contract";
import * as z from "zod";
import { ThreadMessagePageSchema } from "../domain.js";
import { Id } from "../ids.js";

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

export const goalsContract = {
  goals: {
    list: oc
      .input(z.object({ botId: Id, includeClosed: z.boolean().optional() }))
      .output(z.array(GoalSchema)),
    get: oc.input(z.object({ goalId: Id })).output(GoalSchema),
    update: oc.input(UpdateGoalInput).output(GoalSchema),
    acceptProposal: oc.input(z.object({ goalId: Id, proposalId: Id })).output(GoalSchema),
    dismissProposal: oc.input(z.object({ goalId: Id, proposalId: Id })).output(GoalSchema),
    /** The Goal log: what the Muse did on the Goal, one message per finished run, oldest first. */
    log: oc.input(z.object({ goalId: Id })).output(ThreadMessagePageSchema),
  },
};
