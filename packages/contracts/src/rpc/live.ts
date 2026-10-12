import { oc } from "@orpc/contract";
import * as z from "zod";
import { Id } from "../ids.js";
import { AutomationScheduleSchema } from "./automations.js";

/** When to tell the person in chat about an update. */
export const LiveTellSchema = z.enum(["notable", "every", "never"]);
export type LiveTell = z.infer<typeof LiveTellSchema>;

const LiveChangeSchema = z.object({
  id: z.string(),
  before: z.string(),
  after: z.string(),
  source: z.string().nullable(),
  notable: z.boolean(),
});

/** A part the person changed, next to what the source says now. */
const LiveSuggestionSchema = z.object({
  id: z.string(),
  yours: z.string(),
  sourceValue: z.string(),
  source: z.string().nullable(),
});

export const LiveSchema = z.object({
  /** The schedule as the form's choices; `null` for a rule those choices cannot express. */
  schedule: AutomationScheduleSchema.nullable(),
  /** False while the schedule is paused (two updates in a row could not place their changes). */
  active: z.boolean(),
  sources: z.array(z.string()),
  tell: LiveTellSchema,
  followPublish: z.boolean(),
  /** Epoch seconds. */
  checkedAt: z.number().nullable(),
  openIssue: z.string().nullable(),
  lastUpdate: z
    .object({
      version: z.number().int().nullable(),
      applied: z.array(LiveChangeSchema),
      suggestions: z.array(LiveSuggestionSchema),
      at: z.number(),
    })
    .nullable(),
});
export type Live = z.infer<typeof LiveSchema>;
export type LiveChange = z.infer<typeof LiveChangeSchema>;
export type LiveSuggestion = z.infer<typeof LiveSuggestionSchema>;

const target = z.object({ artifactId: Id });
const newVersion = z.object({ id: Id, version: z.number().int() });

export const liveContract = {
  live: {
    get: oc.input(target).output(LiveSchema.nullable()),
    /** Keep the page updated (create or change); fields left out keep their value. */
    save: oc
      .input(
        target.extend({
          schedule: AutomationScheduleSchema,
          sources: z.array(z.string().trim().min(1).max(2048)).max(50).optional(),
          tell: LiveTellSchema.optional(),
          followPublish: z.boolean().optional(),
        }),
      )
      .output(LiveSchema.nullable()),
    /** Stop updating; the versions stay. */
    stop: oc.input(target).output(z.object({ ok: z.literal(true) })),
    /** Update now. */
    run: oc.input(target).output(z.object({ ok: z.literal(true) })),
    /** Undo the newest update (only while it is still the newest version). */
    undo: oc.input(target).output(newVersion),
    /** Take the source's value for a part the person had changed. */
    accept: oc.input(target.extend({ elementId: z.string().min(1) })).output(newVersion),
  },
};
