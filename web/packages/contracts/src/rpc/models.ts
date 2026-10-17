import { oc } from "@orpc/contract";
import * as z from "zod";
import { Id } from "../ids.js";
import { botId } from "./shared.js";

// The engine's model layer as the web sees it (the engine's snake_case, mapped by the client). Every rule - what a key may be, what a budget means, which model is Light - is the
// engine's; these are the shapes the screens render.

/** An upstream the engine has configured: what a key can be for. `operatorKey`: the operator runs
 * their own key for it, so a person may need none. */
export const EngineModelProviderSchema = z.object({
  provider: z.string(),
  label: z.string(),
  operatorKey: z.boolean(),
});
export type EngineModelProvider = z.infer<typeof EngineModelProviderSchema>;

export const EngineModelScopeSchema = z.enum(["user", "org"]);

export const EngineModelConnectionSchema = z.object({
  provider: z.string(),
  hint: z.string(),
  status: z.string(),
  validatedAt: z.number().nullable(),
  label: z.string().nullable(),
  scope: EngineModelScopeSchema,
});
export type EngineModelConnection = z.infer<typeof EngineModelConnectionSchema>;

export const EngineModelHarnessSchema = z.object({ id: z.string(), label: z.string() });

export const EngineModelsStatusSchema = z.object({
  /** `false` when Superchat runs without the engine: nothing below applies. */
  enabled: z.boolean(),
  /** The harnesses the person's Superchat may run on: one when known, both when not yet. */
  harnesses: z.array(EngineModelHarnessSchema),
  /** The engine can serve a model for this person (their key or the organization's). */
  ready: z.boolean(),
});
export type EngineModelsStatus = z.infer<typeof EngineModelsStatusSchema>;

export const EngineModelRowSchema = z.object({
  id: z.string(),
  label: z.string(),
  family: z.string().nullable(),
  isDefault: z.boolean(),
  isUserDefault: z.boolean(),
  /** The model quick Helpers and background work run on for this person. */
  isLight: z.boolean(),
});
export type EngineModelRow = z.infer<typeof EngineModelRowSchema>;

export const EngineModelCatalogSchema = z.object({
  harness: z.string(),
  status: z.string(),
  providerLabel: z.string().nullable(),
  defaultModel: z.string().nullable(),
  /** Light: the person's pick (`lightPick`, `null` = automatic), else `automaticLightModel`, the
   * cheapest model by price. */
  lightModel: z.string().nullable(),
  lightPick: z.string().nullable(),
  automaticLightModel: z.string().nullable(),
  models: z.array(EngineModelRowSchema),
  error: z.string().nullable(),
});
export type EngineModelCatalog = z.infer<typeof EngineModelCatalogSchema>;

export const EngineBudgetActionSchema = z.enum(["stop", "ask"]);

export const EngineBudgetSchema = z.object({
  monthlyLimitUsd: z.number().nullable(),
  atLimit: EngineBudgetActionSchema,
  spentMonthUsd: z.number(),
  /** The organization's cap, read-only for the person. */
  orgLimitUsd: z.number().nullable(),
});
export type EngineBudget = z.infer<typeof EngineBudgetSchema>;

export const EngineBudgetInputSchema = z.object({
  monthlyLimitUsd: z.number().min(0).max(1_000_000).nullable(),
  atLimit: EngineBudgetActionSchema,
});

export const EngineProviderInputSchema = z.object({ provider: z.string().min(1).max(64) });
export const EngineConnectInputSchema = EngineProviderInputSchema.extend({
  apiKey: z.string().min(1).max(4_096),
  label: z.string().max(120).optional(),
});
const ok = z.object({ ok: z.literal(true) });

export const engineModelsContract = {
  engineModels: {
    status: oc.output(EngineModelsStatusSchema),
    providers: oc.output(z.array(EngineModelProviderSchema)),
    connections: oc.output(z.array(EngineModelConnectionSchema)),
    connect: oc.input(EngineConnectInputSchema).output(EngineModelConnectionSchema),
    disconnect: oc.input(EngineProviderInputSchema).output(ok),
    catalog: oc.input(z.object({ harness: z.string().min(1) })).output(EngineModelCatalogSchema),
    preferences: oc.output(z.record(z.string(), z.string())),
    setDefault: oc
      .input(z.object({ harness: z.string().min(1), model: z.string().min(1) }))
      .output(z.record(z.string(), z.string())),
    /** `model: null` goes back to the automatic choice. */
    setLight: oc
      .input(z.object({ harness: z.string().min(1), model: z.string().min(1).nullable() }))
      .output(z.record(z.string(), z.string())),
    budget: oc.output(EngineBudgetSchema),
    setBudget: oc.input(EngineBudgetInputSchema).output(EngineBudgetSchema),
    /** The model this Muse's Conversation runs on (`null`: the person's default). */
    sessionModel: oc.input(botId).output(
      z.object({
        harness: z.string(),
        model: z.string().nullable(),
        catalog: EngineModelCatalogSchema,
      }),
    ),
    setSessionModel: oc
      .input(z.object({ botId: Id, model: z.string().min(1).nullable() }))
      .output(ok),
  },
};
