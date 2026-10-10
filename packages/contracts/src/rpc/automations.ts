import { oc } from "@orpc/contract";
import * as z from "zod";
import { Id } from "../ids.js";

/** The plain choices the "New automation" form offers; the API turns them into an RRULE. */
export const AutomationScheduleSchema = z.object({
  frequency: z.enum(["daily", "weekly", "monthly"]),
  /** Local time of day, `HH:MM` (24h), in the automation's timezone. */
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  /** Weekly: 0 = Monday … 6 = Sunday. */
  weekday: z.number().int().min(0).max(6).optional(),
  /** Monthly: day of the month, 1-28 so every month has it. */
  monthDay: z.number().int().min(1).max(28).optional(),
});
export type AutomationSchedule = z.infer<typeof AutomationScheduleSchema>;

export const AutomationSchema = z.object({
  id: Id,
  name: z.string(),
  prompt: z.string(),
  /** The engine's recurrence rule. */
  rrule: z.string(),
  /** The rule as the form's choices; `null` for a rule those choices cannot express. */
  schedule: AutomationScheduleSchema.nullable(),
  timezone: z.string(),
  enabled: z.boolean(),
  /** ISO timestamp from the engine's scheduler; `null` while paused. */
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  /** `succeeded`, `failed`, `running`, ...; `null` before the first run. */
  lastRunStatus: z.string().nullable(),
  /** The model it runs with; `null` is the default model. */
  model: z.string().nullable(),
  createdAt: z.string(),
});
export type Automation = z.infer<typeof AutomationSchema>;

const botInput = z.object({ botId: Id });
const automationInput = z.object({ botId: Id, id: Id });
const text = {
  name: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(8000),
};

export const automationsContract = {
  automations: {
    list: oc.input(botInput).output(z.array(AutomationSchema)),
    create: oc
      .input(
        z.object({
          botId: Id,
          ...text,
          schedule: AutomationScheduleSchema,
          /** IANA timezone of the person's browser; the engine's default when absent. */
          timezone: z.string().min(1).max(64).optional(),
          /** A model id from the engine catalog; absent runs with the default model. */
          model: z.string().min(1).max(200).optional(),
        }),
      )
      .output(AutomationSchema),
    /** Pause or resume, rename, or change the prompt or schedule. */
    update: oc
      .input(
        z.object({
          botId: Id,
          id: Id,
          enabled: z.boolean().optional(),
          name: text.name.optional(),
          prompt: text.prompt.optional(),
          schedule: AutomationScheduleSchema.optional(),
        }),
      )
      .output(AutomationSchema),
    /** Fire now (fire-and-forget on the engine). */
    run: oc.input(automationInput).output(z.object({ ok: z.literal(true) })),
    remove: oc.input(automationInput).output(z.object({ ok: z.literal(true) })),
  },
};
