import { oc } from "@orpc/contract";
import * as z from "zod";
import {
  ARTIFACT_DESCRIPTION_MAX_LENGTH,
  ARTIFACT_NAME_MAX_LENGTH,
  ATTACHMENT_MAX_BASE64_LENGTH,
} from "../attachments.js";
import { ArtifactSchema, ArtifactVersionSchema, ArtifactWithContentSchema } from "../domain.js";
import { Id } from "../ids.js";

import { botId, threadTarget } from "./shared.js";

export const artifactsContract = {
  artifacts: {
    list: oc.input(botId).output(z.array(ArtifactSchema)),
    listSpace: oc
      .input(
        z.object({
          botId: Id.optional(),
          cursor: z.string().optional(),
          limit: z.number().int().min(1).max(60).optional(),
        }),
      )
      .output(
        z.object({
          items: z.array(ArtifactSchema.extend({ versionCount: z.number().int() })),
          nextCursor: z.string().nullable(),
        }),
      ),
    listVersions: oc.input(z.object({ familyId: Id })).output(z.array(ArtifactVersionSchema)),
    create: oc
      .input(
        threadTarget.and(
          z.object({
            name: z.string().min(1).max(ARTIFACT_NAME_MAX_LENGTH),
            description: z.string().max(ARTIFACT_DESCRIPTION_MAX_LENGTH).optional(),
            mimeType: z.string().min(1),
            contentBase64: z.string().min(1).max(ATTACHMENT_MAX_BASE64_LENGTH),
          }),
        ),
      )
      .output(ArtifactSchema),
    get: oc.input(threadTarget.and(z.object({ artifactId: Id }))).output(ArtifactWithContentSchema),
    getById: oc.input(z.object({ artifactId: Id })).output(ArtifactWithContentSchema),
    remove: oc.input(z.object({ artifactId: Id })).output(z.object({ ok: z.literal(true) })),
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
    saveToLibrary: oc
      .input(z.object({ botId: Id, path: z.string().min(1).max(1024) }))
      .output(ArtifactSchema),
  },
};
