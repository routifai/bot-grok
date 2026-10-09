import { oc } from "@orpc/contract";
import * as z from "zod";
import { Id } from "../ids.js";

export const ARTIFACT_PUBLISH_AUDIENCES = ["owner", "org", "link"] as const;
export const ArtifactPublishAudienceSchema = z.enum(ARTIFACT_PUBLISH_AUDIENCES);
export type ArtifactPublishAudience = z.infer<typeof ArtifactPublishAudienceSchema>;

/** A published app: its address segment, who can open it, the pinned version and view counts. */
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

export const appsContract = {
  apps: {
    publish: oc
      .input(
        z.object({
          artifactId: Id,
          audience: ArtifactPublishAudienceSchema,
          version: z.number().int().min(1).optional(),
        }),
      )
      .output(ArtifactPublishSchema),
    unpublish: oc.input(z.object({ artifactId: Id })).output(z.object({ ok: z.literal(true) })),
    publishState: oc.input(z.object({ artifactId: Id })).output(ArtifactPublishSchema.nullable()),
  },
};
