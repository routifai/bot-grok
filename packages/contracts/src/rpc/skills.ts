import { oc } from "@orpc/contract";
import * as z from "zod";
import {
  AgentSkillCatalogEntrySchema,
  AgentSkillSchema,
  CreateAgentSkillInput,
  CreateScratchpadItemInput,
  ScratchpadItemSchema,
  ScratchpadItemStatusSchema,
  SkillDraftSchema,
  SkillPlaybookSchema,
  TaughtSkillSchema,
  TeachRecordingEventSchema,
  UpdateAgentSkillInput,
} from "../domain.js";
import { Id } from "../ids.js";

import { botId } from "./shared.js";

export const skillsContract = {
  scratchpad: {
    list: oc
      .input(
        z.object({
          botId: Id,
          status: ScratchpadItemStatusSchema.optional(),
          includeDone: z.boolean().optional(),
        }),
      )
      .output(z.array(ScratchpadItemSchema)),
    create: oc.input(CreateScratchpadItemInput).output(ScratchpadItemSchema),
    update: oc
      .input(
        z.object({
          itemId: Id,
          title: z.string().min(1).max(200).optional(),
          status: ScratchpadItemStatusSchema.optional(),
          notes: z.string().max(4_000).optional(),
        }),
      )
      .output(ScratchpadItemSchema),
    remove: oc.input(z.object({ itemId: Id })).output(z.object({ ok: z.literal(true) })),
  },
  skills: {
    list: oc.input(botId).output(z.array(TaughtSkillSchema)),
    get: oc.input(z.object({ skillId: Id })).output(TaughtSkillSchema),
    start: oc
      .input(z.object({ botId: Id, goal: z.string().min(1).max(4000) }))
      .output(TaughtSkillSchema),
    appendEvent: oc
      .input(z.object({ skillId: Id, event: TeachRecordingEventSchema }))
      .output(TaughtSkillSchema),
    snapshot: oc.input(z.object({ skillId: Id })).output(TaughtSkillSchema),
    stop: oc.input(z.object({ skillId: Id })).output(TaughtSkillSchema),
    updateDraft: oc
      .input(
        z.object({
          skillId: Id,
          name: z.string().optional(),
          playbook: SkillPlaybookSchema.optional(),
          draft: SkillDraftSchema.optional(),
        }),
      )
      .output(TaughtSkillSchema),
    save: oc
      .input(z.object({ skillId: Id, name: z.string().optional() }))
      .output(TaughtSkillSchema),
    testRun: oc
      .input(
        z.object({
          skillId: Id,
          prompt: z.string().optional(),
          inputs: z.record(z.string(), z.string()).optional(),
        }),
      )
      .output(z.object({ runId: Id })),
    remove: oc.input(z.object({ skillId: Id })).output(z.object({ ok: z.literal(true) })),
  },
  /** Claude Agent Skills (SKILL.md recipes) shared across assistants (not taught/demo skills). Pi already understands this format; we persist and inject them. */
  agentSkills: {
    list: oc.output(z.array(AgentSkillCatalogEntrySchema)),
    get: oc
      .input(
        z
          .object({ skillId: Id.optional(), name: z.string().min(1).max(80).optional() })
          .superRefine((input, ctx) => {
            if (!input.skillId && !input.name?.trim()) {
              ctx.addIssue({
                code: "custom",
                message: "Provide skillId or name",
                path: ["skillId"],
              });
            }
          }),
      )
      .output(AgentSkillSchema),
    create: oc.input(CreateAgentSkillInput).output(AgentSkillSchema),
    update: oc.input(UpdateAgentSkillInput).output(AgentSkillSchema),
    remove: oc.input(z.object({ skillId: Id })).output(z.object({ ok: z.literal(true) })),
  },
};
