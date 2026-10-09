import { oc } from "@orpc/contract";
import * as z from "zod";
import { AiConsentQuerySchema, AiConsentStatusSchema } from "../ai-consent.js";
import {
  AppBootstrapSchema,
  AvatarStyleSchema,
  DeploymentSettingsSchema,
  ExportManifestSchema,
  MeSchema,
  SpaceNavigationSchema,
  SpaceSchema,
  UsageRecordSchema,
} from "../domain.js";
import { Id } from "../ids.js";
import { RunsListOutputSchema } from "../runs.js";
import { SearchQueryOutputSchema } from "../search.js";

import { botId } from "./shared.js";

export const accountContract = {
  aiConsent: {
    status: oc.input(AiConsentQuerySchema).output(AiConsentStatusSchema),
    allow: oc
      .input(
        z.object({
          scope: z.string(),
          version: z.string(),
          keys: z.array(z.string()).min(1).max(200),
        }),
      )
      .output(AiConsentStatusSchema),
    revoke: oc.input(z.object({ key: z.string().nullable() })).output(AiConsentStatusSchema),
  },
  health: oc.output(z.object({ ok: z.literal(true), version: z.string() })),
  me: oc.output(MeSchema),
  preferences: {
    // `timezone` is validated server-side (invalid IANA names fall back to "UTC");
    // the web app sends the browser's zone once per session (ProactivitySettings.tsx).
    update: oc
      .input(
        z.object({ avatarStyle: AvatarStyleSchema.optional(), timezone: z.string().optional() }),
      )
      .output(MeSchema),
  },
  spaces: {
    list: oc.output(SpaceNavigationSchema),
    create: oc.input(z.object({ name: z.string().trim().min(1).max(60) })).output(SpaceSchema),
    remove: oc
      .input(z.object({ spaceId: Id }))
      .output(z.object({ ok: z.literal(true), activeSpaceId: Id })),
  },
  bootstrap: oc.input(z.object({ botId: Id.optional() })).output(AppBootstrapSchema),
  deployment: {
    get: oc.output(DeploymentSettingsSchema),
    update: oc
      .input(
        z.object({
          computerHost: z.enum(["docker", "this-mac"]).nullable().optional(),
        }),
      )
      .output(DeploymentSettingsSchema),
  },
  usage: {
    list: oc.output(z.array(UsageRecordSchema)),
    summary: oc.output(
      z.object({
        inputTokens: z.number(),
        outputTokens: z.number(),
        runs: z.number(),
      }),
    ),
  },
  export: {
    bot: oc.input(botId).output(ExportManifestSchema),
  },
  notifications: {
    registerPush: oc
      .input(z.object({ token: z.string().min(8).max(512) }))
      .output(z.object({ ok: z.literal(true) })),
    unregisterPush: oc.output(z.object({ ok: z.literal(true) })),
  },
  search: {
    query: oc.input(z.object({ q: z.string().max(200) })).output(SearchQueryOutputSchema),
  },
  runs: {
    list: oc.input(z.object({ filter: z.enum(["active", "recent"]) })).output(RunsListOutputSchema),
  },
};
