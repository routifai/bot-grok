import * as z from "zod";
import { Id } from "../ids.js";

export const botId = z.object({ botId: Id });

export const groupId = z.object({ groupId: Id });

export const threadTarget = z
  .object({
    botId: Id.optional(),
    groupId: Id.optional(),
  })
  .superRefine((input, ctx) => {
    const hasBot = Boolean(input.botId);
    const hasGroup = Boolean(input.groupId);
    if (hasBot === hasGroup) {
      ctx.addIssue({
        code: "custom",
        message: "Provide exactly one of botId or groupId",
        path: ["botId"],
      });
    }
  });
