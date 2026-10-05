import { oc } from "@orpc/contract";
import * as z from "zod";
import { ThreadMessagePageSchema } from "../domain.js";
import { Id } from "../ids.js";
import { AnswerAskInput, AskSchema, GoalSchema, UpdateGoalInput } from "../muse.js";

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
  asks: {
    list: oc.input(z.object({ botId: Id })).output(z.array(AskSchema)),
    count: oc.input(z.object({ botId: Id })).output(z.object({ count: z.number().int() })),
    answer: oc.input(AnswerAskInput).output(z.object({ ok: z.literal(true) })),
  },
  /** What the engine may do without asking: standing rules (revocable) and the daily
   * spending cap. Waiting approvals themselves arrive as `asks`. */
};
