// `apps.*` for Muses whose files the engine owns: publish a saved HTML file at its own address.
import {
  getOmnigentPublication,
  type OmnigentClientConfig,
  publishOmnigentArtifact,
  unpublishOmnigentArtifact,
} from "@nova/adapters";
import type { Actor, ArtifactPublish, ArtifactPublishAudience } from "@nova/contracts";
import { ORPCError } from "@orpc/server";
import { type EngineArtifactsDeps, emailOf, notFound, toPublish } from "../artifacts/index.js";

/** Only the owner's own file is ever found: the engine 404s another owner's artifact. */
export async function enginePublishArtifact(
  deps: EngineArtifactsDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  input: { artifactId: string; audience: ArtifactPublishAudience; version?: number },
): Promise<ArtifactPublish> {
  const email = await emailOf(deps, actor);
  const published = await publishOmnigentArtifact(client, email, input.artifactId, {
    audience: input.audience,
    version: input.version,
  }).catch(publishError);
  return toPublish(published);
}

export async function engineUnpublishArtifact(
  deps: EngineArtifactsDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  artifactId: string,
): Promise<{ ok: true }> {
  await unpublishOmnigentArtifact(client, await emailOf(deps, actor), artifactId).catch(notFound);
  return { ok: true as const };
}

export async function engineGetPublication(
  deps: EngineArtifactsDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  artifactId: string,
): Promise<ArtifactPublish | null> {
  const publication = await getOmnigentPublication(
    client,
    await emailOf(deps, actor),
    artifactId,
  ).catch(notFound);
  return publication ? toPublish(publication) : null;
}

function publishError(error: unknown): never {
  if (error instanceof Error && /\(400\)/.test(error.message)) {
    throw new ORPCError("BAD_REQUEST", { message: "This file cannot be published" });
  }
  return notFound(error);
}
