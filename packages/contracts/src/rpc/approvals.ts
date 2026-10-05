import { oc } from "@orpc/contract";
import * as z from "zod";
import {
  ActionApprovalRuleSchema,
  ActionAutoReviewSettingsSchema,
  AgentSecretInputSchema,
  AgentSecretSchema,
} from "../domain.js";
import { Id } from "../ids.js";
import { ApprovalSpendingSchema, ApprovalStandingRuleSchema } from "../muse.js";

import { botId } from "./shared.js";

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
  agentSecrets: {
    list: oc.output(z.array(AgentSecretSchema)),
    put: oc.input(AgentSecretInputSchema).output(AgentSecretSchema),
    remove: oc.input(z.object({ id: Id })).output(z.object({ ok: z.literal(true) })),
  },
  // Muse edition. The Super Chat's Side Chats (CONTEXT.md "Side Chat"); the UI folds
  // Archived ones instead of hiding them.
};
