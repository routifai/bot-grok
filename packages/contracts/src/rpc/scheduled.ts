import { oc } from "@orpc/contract";
import * as z from "zod";
import { CreateRoutineInput, RoutineSchema } from "../domain.js";
import { Id, IsoDate } from "../ids.js";

import { botId } from "./shared.js";

export const scheduledContract = {
  routines: {
    list: oc.input(botId).output(z.array(RoutineSchema)),
    create: oc.input(CreateRoutineInput).output(RoutineSchema),
    update: oc
      .input(
        z
          .object({
            routineId: Id,
            name: z.string().optional(),
            prompt: z.string().optional(),
            crons: z.array(z.string().min(1)).optional(),
            timezone: z.string().optional(),
            active: z.boolean().optional(),
            notify: z.boolean().optional(),
            webhookEnabled: z.boolean().optional(),
            githubEnabled: z.boolean().optional(),
            messageProvider: z
              .string()
              .min(1)
              .max(50)
              .regex(/^[a-z0-9._-]+$/i)
              .nullable()
              .optional(),
            /** ISO datetime to arm a never-run one-shot. */
            runAt: IsoDate.optional(),
          })
          .superRefine((value, ctx) => {
            if (
              value.crons &&
              value.crons.length === 0 &&
              value.webhookEnabled === false &&
              value.githubEnabled === false &&
              value.messageProvider === null
            ) {
              ctx.addIssue({
                code: "custom",
                message: "Add a schedule, webhook, GitHub, or message trigger",
                path: ["crons"],
              });
            }
          }),
      )
      .output(RoutineSchema),
    remove: oc.input(z.object({ routineId: Id })).output(z.object({ ok: z.literal(true) })),
    testRun: oc
      .input(
        z.object({
          routineId: Id,
          clientNonce: z.string().min(1).max(200).optional(),
        }),
      )
      .output(z.object({ runId: Id })),
  },
};
