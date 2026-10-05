import { oc } from "@orpc/contract";
import * as z from "zod";
import {
  BotSchema,
  BotSectionSchema,
  ComputerModeSchema,
  CreateBotInput,
  CreateGroupInput,
  GroupDetailSchema,
  GroupSchema,
  ReorderBotsInput,
  UpdateBotInput,
  UpdateGroupInput,
} from "../domain.js";
import { Id } from "../ids.js";

import { botId, groupId, threadTarget } from "./shared.js";

export const botsContract = {
  bots: {
    list: oc.output(z.array(BotSchema)),
    listArchived: oc.output(z.array(BotSchema)),
    get: oc.input(botId).output(BotSchema),
    create: oc.input(CreateBotInput).output(BotSchema),
    duplicate: oc.input(botId).output(BotSchema),
    reorder: oc.input(ReorderBotsInput).output(z.object({ ok: z.literal(true) })),
    update: oc.input(UpdateBotInput).output(BotSchema),
    setComputer: oc.input(z.object({ botId: Id, mode: ComputerModeSchema })).output(BotSchema),
    archive: oc.input(botId).output(z.object({ ok: z.literal(true) })),
    restore: oc.input(botId).output(z.object({ ok: z.literal(true) })),
    remove: oc
      .input(z.object({ botId: Id, deleteMemories: z.boolean().default(false) }))
      .output(z.object({ ok: z.literal(true) })),
    rotateWebhookSecret: oc.input(botId).output(
      z.object({
        secret: z.string(),
        path: z.string(),
        webhookConfigured: z.literal(true),
      }),
    ),
  },
  groups: {
    create: oc.input(CreateGroupInput).output(GroupSchema),
    list: oc.output(z.array(GroupSchema)),
    listArchived: oc.output(z.array(GroupSchema)),
    get: oc.input(groupId).output(GroupDetailSchema),
    duplicate: oc.input(groupId).output(GroupSchema),
    update: oc.input(UpdateGroupInput).output(GroupSchema),
    archive: oc.input(groupId).output(z.object({ ok: z.literal(true) })),
    restore: oc.input(groupId).output(z.object({ ok: z.literal(true) })),
    remove: oc.input(groupId).output(z.object({ ok: z.literal(true) })),
  },
  botSections: {
    list: oc.output(z.array(BotSectionSchema)),
    create: oc
      .input(threadTarget.safeExtend({ name: z.string().trim().min(1).max(60) }))
      .output(BotSectionSchema),
    update: oc
      .input(z.object({ sectionId: Id, name: z.string().trim().min(1).max(60) }))
      .output(BotSectionSchema),
  },
};
