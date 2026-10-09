import { oc } from "@orpc/contract";
import * as z from "zod";
import {
  ARTIFACT_DESCRIPTION_MAX_LENGTH,
  ARTIFACT_NAME_MAX_LENGTH,
  ATTACHMENT_MAX_BASE64_LENGTH,
} from "../attachments.js";
import { Id } from "../ids.js";

import { botId, threadTarget } from "./shared.js";

export const ARTIFACT_PUBLISH_AUDIENCES = ["owner", "org", "link"] as const;
export const ArtifactPublishAudienceSchema = z.enum(ARTIFACT_PUBLISH_AUDIENCES);
export type ArtifactPublishAudience = z.infer<typeof ArtifactPublishAudienceSchema>;

/** A published app (the apps capability builds on this shape; it rides on artifact rows): its address segment, who can open it, the pinned version and view counts. */
export const ArtifactPublishSchema = z.object({
  slug: z.string(),
  /** The path the app is served at, e.g. `/apps/budget-k3m9xq`. */
  urlPath: z.string(),
  audience: ArtifactPublishAudienceSchema,
  version: z.number().int(),
  publishedAt: z.string(),
  stats: z.object({
    opensTotal: z.number().int(),
    uniqueViewers: z.number().int(),
    opens7d: z.number().int(),
  }),
});
export type ArtifactPublish = z.infer<typeof ArtifactPublishSchema>;

export const ArtifactSchema = z.object({
  id: Id,
  botId: Id.nullable(),
  groupId: Id.nullable(),
  runId: Id.nullable(),
  name: z.string(),
  description: z.string().nullable(),
  mimeType: z.string(),
  size: z.number().int(),
  version: z.number().int(),
  createdAt: z.string(),
  /** Set when the file is published as an app. */
  publish: ArtifactPublishSchema.nullish(),
});

export type Artifact = z.infer<typeof ArtifactSchema>;

export const ArtifactVersionSchema = z.object({
  id: Id,
  version: z.number().int(),
  name: z.string(),
  createdAt: z.string(),
  /** "manual" when the person edited it by hand. */
  origin: z.string().optional(),
  parentVersionId: Id.nullable().optional(),
  editSummary: z.string().nullable().optional(),
});

export type ArtifactVersion = z.infer<typeof ArtifactVersionSchema>;

export const ArtifactWithContentSchema = ArtifactSchema.extend({
  contentBase64: z.string(),
});
export type ArtifactWithContent = z.infer<typeof ArtifactWithContentSchema>;

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
};
