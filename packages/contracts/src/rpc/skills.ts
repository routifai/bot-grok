import { oc } from "@orpc/contract";
import * as z from "zod";
import { Id } from "../ids.js";

import { botId } from "./shared.js";

export const TaughtSkillStatusSchema = z.enum([
  "recording",
  "drafting",
  "draft",
  "saved",
  "failed",
]);
export type TaughtSkillStatus = z.infer<typeof TaughtSkillStatusSchema>;

export const SkillPlaybookSchema = z.object({
  whenToUse: z.string(),
  inputs: z.array(z.string()),
  steps: z.array(z.string()),
  howToCheck: z.string(),
  whatToReturn: z.string(),
  approvalBoundaries: z.string(),
  failureHandling: z.string(),
});
export type SkillPlaybook = z.infer<typeof SkillPlaybookSchema>;

/** A taught skill as the engine drafted it: intent-level steps with a check each, approval
 * points and typed inputs (engine/omnigent/omnigent/superchat/taught_skills.py). */
export const SkillDraftSchema = z.object({
  preconditions: z.array(z.string()),
  inputs: z.array(
    z.object({
      name: z.string(),
      label: z.string(),
      default: z.string(),
      description: z.string().optional(),
    }),
  ),
  steps: z.array(
    z.object({
      intent: z.string(),
      check: z.string(),
      approval: z.boolean(),
      /** Name of the keyframe that shows this step; the image is in `TaughtSkill.keyframes`. */
      keyframe: z.string().nullable(),
      hint: z
        .object({
          role: z.string().optional(),
          name: z.string().optional(),
          selector: z.string().optional(),
          url: z.string().optional(),
        })
        .optional(),
    }),
  ),
  returns: z.string(),
});
export type SkillDraft = z.infer<typeof SkillDraftSchema>;

export const TeachRecordingEventSchema = z.object({
  at: z.string(),
  kind: z.enum(["pointer", "key", "clipboard", "snapshot", "scroll"]),
  x: z.number().optional(),
  y: z.number().optional(),
  button: z.string().optional(),
  type: z.string().optional(),
  key: z.string().optional(),
  text: z.string().optional(),
  summary: z.string().optional(),
});
export type TeachRecordingEvent = z.infer<typeof TeachRecordingEventSchema>;

export const TeachSnapshotSchema = z.object({
  at: z.string(),
  summary: z.string(),
  hash: z.string().optional(),
});
export type TeachSnapshot = z.infer<typeof TeachSnapshotSchema>;

export const TeachRecordingSchema = z.object({
  events: z.array(TeachRecordingEventSchema),
  snapshots: z.array(TeachSnapshotSchema),
  controlLeaseId: z.string().optional(),
});
export type TeachRecording = z.infer<typeof TeachRecordingSchema>;

export const TaughtSkillSchema = z.object({
  id: Id,
  botId: Id,
  name: z.string(),
  goal: z.string(),
  status: TaughtSkillStatusSchema,
  playbook: SkillPlaybookSchema,
  /** The engine's draft (steps, inputs, approvals); `null` until the teacher has written it. */
  draft: SkillDraftSchema.nullable().optional(),
  /** Keyframe images by name as `data:` URIs; only on a single-skill read. */
  keyframes: z.record(z.string(), z.string()).optional(),
  recording: TeachRecordingSchema,
  startedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  stoppedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TaughtSkill = z.infer<typeof TaughtSkillSchema>;

export const AgentSkillSourceSchema = z.enum(["user", "builtin", "plugin"]);
export type AgentSkillSource = z.infer<typeof AgentSkillSourceSchema>;

export const AgentSkillSchema = z.object({
  id: Id,
  name: z.string(),
  description: z.string(),
  content: z.string(),
  source: AgentSkillSourceSchema,
  readOnly: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AgentSkill = z.infer<typeof AgentSkillSchema>;

export const AgentSkillCatalogEntrySchema = AgentSkillSchema.pick({
  id: true,
  name: true,
  description: true,
  source: true,
  readOnly: true,
});
export type AgentSkillCatalogEntry = z.infer<typeof AgentSkillCatalogEntrySchema>;

export const CreateAgentSkillInput = z
  .object({
    content: z.string().min(1).max(100_000).optional(),
    name: z.string().min(1).max(80).optional(),
    description: z.string().min(1).max(2000).optional(),
    body: z.string().max(100_000).optional(),
  })
  .superRefine((input, ctx) => {
    if (input.content?.trim()) return;
    if (!input.name?.trim() || !input.description?.trim()) {
      ctx.addIssue({
        code: "custom",
        message: "Provide content (SKILL.md) or name + description (+ optional body)",
        path: ["content"],
      });
    }
  });

export const UpdateAgentSkillInput = z
  .object({
    skillId: Id,
    content: z.string().min(1).max(100_000).optional(),
    name: z.string().min(1).max(80).optional(),
    description: z.string().min(1).max(2000).optional(),
    body: z.string().max(100_000).optional(),
  })
  .superRefine((input, ctx) => {
    if (
      input.content === undefined &&
      input.name === undefined &&
      input.description === undefined &&
      input.body === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Provide at least one field to update",
        path: ["content"],
      });
    }
  });

export const skillsContract = {
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
    /** The person's key, click or scroll on the Computer while teaching: recorded into the skill,
     * or applied to the desktop when nothing is being recorded. */
    input: oc
      .input(
        z.object({
          botId: Id,
          kind: z.enum(["key", "pointer", "clipboard", "scroll"]),
          payload: z.record(z.string(), z.unknown()),
        }),
      )
      .output(z.object({ ok: z.literal(true) })),
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
