import { oc } from "@orpc/contract";
import * as z from "zod";
import { ActionApprovalRuleSchema, ActionAutoReviewSettingsSchema } from "../domain.js";
import { Id } from "../ids.js";
import { botId } from "./shared.js";

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

export const approvalsContract = {
  approvalRules: {
    list: oc.output(z.array(ActionApprovalRuleSchema)),
    set: oc
      .input(
        z.object({
          effect: z.enum(["always_allow", "require_approval"]),
          matchKind: z.enum(["tool", "connector", "category"]),
          matchValue: z.string().min(1),
        }),
      )
      .output(ActionApprovalRuleSchema),
    remove: oc.input(z.object({ id: Id })).output(z.object({ ok: z.literal(true) })),
  },
  autoReview: {
    get: oc.output(ActionAutoReviewSettingsSchema),
    set: oc.input(z.object({ enabled: z.boolean() })).output(ActionAutoReviewSettingsSchema),
  },
  approvals: {
    rules: oc
      .input(botId)
      .output(
        z.object({ rules: z.array(ApprovalStandingRuleSchema), spending: ApprovalSpendingSchema }),
      ),
    revoke: oc.input(z.object({ botId: Id, ruleId: Id })).output(z.object({ ok: z.literal(true) })),
    setSpending: oc
      .input(z.object({ botId: Id, dailyCapUsd: z.number().min(0).max(1_000_000) }))
      .output(ApprovalSpendingSchema),
  },
  asks: {
    list: oc.input(z.object({ botId: Id })).output(z.array(AskSchema)),
    count: oc.input(z.object({ botId: Id })).output(z.object({ count: z.number().int() })),
    answer: oc.input(AnswerAskInput).output(z.object({ ok: z.literal(true) })),
  },
};
