import { eventIterator, oc } from "@orpc/contract";
import * as z from "zod";
import { ActivityChangedSchema, ActivityPageSchema, ActivitySchema } from "../activity.js";
import { Id } from "../ids.js";

import { botId } from "./shared.js";

/** One day's note (engine daily notes). `sections` is keyed by the engine's section keys. */
const VaultEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  site: z.string(),
  username: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
});

const VaultRequestSchema = z.object({
  id: z.string(),
  name: z.string(),
  site: z.string(),
  reason: z.string(),
  status: z.enum(["pending", "saved", "expired"]),
});

const DailyNoteSchema = z.object({
  date: z.string(),
  sections: z.record(z.string(), z.string()),
  editedByPerson: z.boolean(),
  finalized: z.boolean(),
  updatedAt: z.number(),
});

/** One memory claim for the Memory tab's editable sections (engine `memory/claims`). `origin`
 * is where it came from: the person's words, their own edit, or something Nova noticed. */
const MemoryClaimSchema = z.object({
  id: z.string(),
  kind: z.string(),
  text: z.string(),
  origin: z.enum(["said", "edited", "noticed"]),
  personAuthored: z.boolean(),
  /** Epoch seconds the claim was last confirmed (first written when never reinforced). */
  date: z.number(),
});

export const memoryContract = {
  memory: {
    /** The Muse's Memory Profile from Omnigent (docs/super-chat/README.md): what it carries
     * into every turn about the person. `null` when nothing is remembered yet. */
    profile: oc.input(z.object({ botId: Id })).output(z.object({ profile: z.string().nullable() })),
    /** Active memory claims for the Memory tab's sections (engine `GET .../memory/claims`),
     * newest first; each carries its kind, source and date. */
    claims: oc
      .input(z.object({ botId: Id }))
      .output(z.object({ claims: z.array(MemoryClaimSchema) })),
    /** The person's text edit of one claim: it becomes person-authored (upkeep and Helpers
     * never overwrite it). */
    editClaim: oc
      .input(z.object({ botId: Id, claimId: z.string(), text: z.string().min(1).max(2000) }))
      .output(MemoryClaimSchema),
    /** The person deletes one claim. */
    forgetClaim: oc
      .input(z.object({ botId: Id, claimId: z.string() }))
      .output(z.object({ ok: z.literal(true) })),
    /** The person's daily notes (engine `GET /v1/me/daily-notes`), newest first: one per local
     * day, sections keyed `talked_about` / `decisions` / `promised` / `open_loops`. */
    dailyNotes: oc
      .input(z.object({ botId: Id, limit: z.number().int().min(1).max(60).default(14) }))
      .output(z.object({ notes: z.array(DailyNoteSchema) })),
    /** The person's edit of one day's note: given sections win and the engine's writers only
     * append to them afterwards. */
    saveDailyNote: oc
      .input(
        z.object({
          botId: Id,
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          sections: z.record(z.string(), z.string().max(6000)),
        }),
      )
      .output(DailyNoteSchema),
  },
  /** The person's secrets vault (engine `/v1/me/vault`): saved logins, metadata only. A value
   * is accepted once by `save` and never returned, logged or sent to the model. */
  vault: {
    list: oc.input(botId).output(z.object({ entries: z.array(VaultEntrySchema) })),
    remove: oc
      .input(z.object({ botId: Id, id: z.string() }))
      .output(z.object({ ok: z.literal(true) })),
    /** The secure-entry card's request (what the Muse asked for), by id. */
    request: oc.input(z.object({ botId: Id, requestId: z.string() })).output(VaultRequestSchema),
    /** The secure-entry form's submit; saves the login and, with `requestId`, closes the card. */
    save: oc
      .input(
        z.object({
          botId: Id,
          requestId: z.string().optional(),
          name: z.string().min(1).max(128),
          site: z.string().min(1).max(512),
          username: z.string().max(256).optional(),
          password: z.string().min(1).max(4096),
        }),
      )
      .output(VaultEntrySchema),
  },
  activities: {
    list: oc
      .input(
        z.object({
          botId: Id,
          /** Epoch seconds; only Activities started strictly before this. */
          before: z.number().int().nonnegative().optional(),
          limit: z.number().int().positive().max(100).optional(),
        }),
      )
      .output(ActivityPageSchema),
    get: oc.input(z.object({ botId: Id, activityId: z.string().min(1) })).output(ActivitySchema),
    /** Live signal: one event on connect and one each time the Activity Feed may have changed
     * (a Helper started, stepped, settled). Carries no content; the client re-reads `list`. */
    watch: oc.input(z.object({ botId: Id })).output(eventIterator(ActivityChangedSchema)),
  },
};
