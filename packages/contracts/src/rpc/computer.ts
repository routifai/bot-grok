import { oc } from "@orpc/contract";
import * as z from "zod";
import { ARTIFACT_NAME_MAX_LENGTH, ATTACHMENT_MAX_BASE64_LENGTH } from "../attachments.js";
import {
  ComputerReleaseReasonSchema,
  ComputerStatusSchema,
  ComputerUpdateSchema,
} from "../domain.js";
import { Id } from "../ids.js";

import { ArtifactSchema } from "./artifacts.js";
import { botId } from "./shared.js";

export const ComputerRunnerSchema = z.object({
  /** The engine host; `null` for the managed Computer before it first starts. */
  hostId: z.string().nullable(),
  name: z.string(),
  /** `computer`: the managed Computer the engine starts (sandbox provider); `host`: a machine
   * the person connected with `omni host`. */
  kind: z.enum(["computer", "host"]),
  provider: z.string().nullable(),
  online: z.boolean(),
  current: z.boolean(),
  /** Whether the Conversation can move here now. */
  movable: z.boolean(),
});
export type ComputerRunner = z.infer<typeof ComputerRunnerSchema>;

export const ComputerRuntimeSchema = z.object({
  /** A reply is running: the engine refuses switching the harness until it ends. */
  busy: z.boolean(),
  /** The agent bundle the Conversation runs on, e.g. `superchat-claude`. */
  agent: z.string().nullable(),
  /** Superchat's agent bundles on the engine, with the harness each runs. */
  agents: z.array(z.object({ name: z.string(), harness: z.string().nullable() })),
  runners: z.array(ComputerRunnerSchema),
  /** The managed Computer can't hand the Conversation to a host (or take it back): the engine
   * keeps managed placement server-owned. */
  managed: z.boolean(),
  /** The command that connects this machine as a host, when the engine lets people sign in
   * their own hosts; `null` otherwise. */
  connectCommand: z.string().nullable(),
});
export type ComputerRuntime = z.infer<typeof ComputerRuntimeSchema>;

export const computerContract = {
  computer: {
    status: oc.input(botId).output(ComputerStatusSchema),
    boot: oc.input(botId).output(ComputerStatusSchema),
    stop: oc.input(botId).output(ComputerStatusSchema),
    recover: oc.input(botId).output(ComputerUpdateSchema),
    reset: oc.input(botId).output(ComputerStatusSchema),
    update: oc.input(botId).output(ComputerUpdateSchema),
    updates: oc.output(z.array(ComputerUpdateSchema)),
    releaseInterrupted: oc
      .input(z.object({ id: Id, workersStopped: z.literal(true) }))
      .output(z.object({ ok: z.literal(true) })),
    dismissUpdate: oc.input(z.object({ id: Id })).output(z.object({ ok: z.literal(true) })),
    takeover: oc.input(botId).output(z.object({ leaseId: Id, expiresAt: z.string() })),
    release: oc
      .input(
        z.object({
          botId: Id,
          reason: ComputerReleaseReasonSchema.optional(),
        }),
      )
      .output(z.object({ ok: z.literal(true) })),
    files: oc
      .input(z.object({ botId: Id, path: z.string().default("/") }))
      .output(
        z.array(z.object({ path: z.string(), kind: z.enum(["file", "dir"]), size: z.number() })),
      ),
    readFile: oc
      .input(z.object({ botId: Id, path: z.string() }))
      .output(z.object({ path: z.string(), content: z.string() })),
    screenUrl: oc.input(botId).output(z.object({ url: z.string().nullable() })),
    heartbeat: oc.input(botId).output(z.object({ ok: z.literal(true) })),
    /** Which engine host and agent bundle the Muse's Conversation runs on (read-only; Settings). */
    host: oc.input(botId).output(
      z.object({
        hostId: z.string().nullable(),
        agentName: z.string().nullable(),
        /** The harness the agent bundle runs, e.g. `claude-sdk` or `pi`; `null` when unknown. */
        harness: z.string().nullable(),
      }),
    ),
    /** What the Muse's Conversation can run on and where (Settings > Computer). */
    runtime: oc.input(botId).output(ComputerRuntimeSchema),
    /** Runs the Conversation on another of the engine's agent bundles, from the next message. */
    setAgent: oc
      .input(z.object({ botId: Id, agent: z.string().min(1).max(200) }))
      .output(z.object({ agent: z.string() })),
    /** Moves the Conversation onto one of the person's own hosts (`omni host`). `workspace` is a
     * folder on that host; its home when omitted. */
    moveRunner: oc
      .input(
        z.object({
          botId: Id,
          hostId: z.string().min(1).max(200),
          workspace: z.string().max(1024).optional(),
        }),
      )
      .output(z.object({ hostId: z.string() })),
  },
  files: {
    list: oc.input(z.object({ botId: Id, path: z.string().max(1024).default("") })).output(
      z.object({
        entries: z.array(
          z.object({
            name: z.string(),
            path: z.string(),
            type: z.enum(["file", "directory"]),
            size: z.number().int().nullable(),
            modifiedAt: z.number().int(),
          }),
        ),
      }),
    ),
    read: oc.input(z.object({ botId: Id, path: z.string().min(1).max(1024) })).output(
      z.object({
        path: z.string(),
        name: z.string(),
        mimeType: z.string(),
        size: z.number().int(),
        /** Over the preview cap, or not text-like and not previewable: no content sent. */
        tooLarge: z.boolean(),
        binary: z.boolean(),
        contentBase64: z.string().nullable(),
      }),
    ),
    /** Writes a composer attachment into the Muse's workspace (`your_files/uploads/<date>/`). */
    uploadAttachment: oc
      .input(
        z.object({
          botId: Id,
          name: z.string().min(1).max(ARTIFACT_NAME_MAX_LENGTH),
          mimeType: z.string().min(1).max(200),
          contentBase64: z.string().min(1).max(ATTACHMENT_MAX_BASE64_LENGTH),
        }),
      )
      .output(
        z.object({
          path: z.string(),
          name: z.string(),
          mimeType: z.string(),
          size: z.number().int(),
        }),
      ),
    /** Reads an uploaded attachment in the Computer (Markdown, passages, embeddings, index) and
     * answers when it is searchable. The composer awaits it before Send is enabled. */
    ingestAttachment: oc.input(z.object({ botId: Id, path: z.string().min(1).max(1024) })).output(
      z.object({
        fileId: z.string(),
        name: z.string(),
        pages: z.number().int(),
        chars: z.number().int(),
      }),
    ),
    saveToLibrary: oc
      .input(z.object({ botId: Id, path: z.string().min(1).max(1024) }))
      .output(ArtifactSchema),
  },
};
