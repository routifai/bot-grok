import { oc } from "@orpc/contract";
import * as z from "zod";
import {
  EngineBudgetActionSchema,
  EngineBudgetInputSchema,
  EngineConnectInputSchema,
  EngineModelConnectionSchema,
  EngineProviderInputSchema,
} from "./models.js";

// The organization's side of the engine's model layer, admin only (apps/api/src/features/admin/
// service.ts maps the engine's snake_case): the model overlay, the organization budget and keys,
// people, usage, suspension. The engine decides who is an admin.

export const EngineOverlayEntrySchema = z.object({
  allow: z.array(z.string()).nullable(),
  default: z.string().nullable(),
});
export const EngineOverlaySchema = z.record(z.string(), EngineOverlayEntrySchema);

export const EngineAdminUserSchema = z.object({
  id: z.string(),
  email: z.string().nullable(),
  isAdmin: z.boolean(),
  status: z.enum(["active", "suspended"]),
  spendMonthUsd: z.number(),
  spendTodayUsd: z.number(),
  sessionCount: z.number(),
  providers: z.array(z.string()),
  budget: z.object({ monthlyLimitUsd: z.number().nullable(), atLimit: EngineBudgetActionSchema }),
  computer: z.enum(["online", "offline"]).nullable(),
  lastActive: z.number().nullable(),
});
export type EngineAdminUser = z.infer<typeof EngineAdminUserSchema>;

export const EngineUsageWindowSchema = z.enum(["day", "month"]);

export const EngineAdminUsageSchema = z.object({
  window: EngineUsageWindowSchema,
  totalUsd: z.number(),
  byUser: z.array(z.object({ userId: z.string(), costUsd: z.number() })),
  byDay: z.array(z.object({ day: z.string(), costUsd: z.number() })),
});
export type EngineAdminUsage = z.infer<typeof EngineAdminUsageSchema>;

const ok = z.object({ ok: z.literal(true) });

export const engineAdminContract = {
  engineAdmin: {
    connections: oc.output(z.array(EngineModelConnectionSchema)),
    connect: oc.input(EngineConnectInputSchema).output(EngineModelConnectionSchema),
    disconnect: oc.input(EngineProviderInputSchema).output(ok),
    models: oc.output(EngineOverlaySchema),
    modelsCatalog: oc.input(z.object({ harness: z.string().min(1) })).output(
      z.object({
        harness: z.string(),
        status: z.string(),
        defaultModel: z.string().nullable(),
        models: z.array(
          z.object({ id: z.string(), label: z.string(), family: z.string().nullable() }),
        ),
      }),
    ),
    setModels: oc.input(z.object({ harnesses: EngineOverlaySchema })).output(EngineOverlaySchema),
    budget: oc.output(
      z.object({
        monthlyLimitUsd: z.number().nullable(),
        atLimit: EngineBudgetActionSchema,
        spentMonthUsd: z.number(),
      }),
    ),
    setBudget: oc.input(EngineBudgetInputSchema).output(
      z.object({
        monthlyLimitUsd: z.number().nullable(),
        atLimit: EngineBudgetActionSchema,
        spentMonthUsd: z.number(),
      }),
    ),
    users: oc.output(z.array(EngineAdminUserSchema)),
    usage: oc.input(z.object({ window: EngineUsageWindowSchema })).output(EngineAdminUsageSchema),
    setSuspended: oc
      .input(z.object({ userId: z.string().min(1), suspended: z.boolean() }))
      .output(ok),
    deleteUser: oc.input(z.object({ userId: z.string().min(1) })).output(ok),
  },
};
