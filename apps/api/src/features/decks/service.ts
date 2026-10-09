// `decks.*` for Muses whose files the engine owns: a `.deck.html` exported to PowerPoint or PDF
// in the person's Computer.
import { exportOmnigentDeck, OmnigentApiError, type OmnigentClientConfig } from "@nova/adapters";
import type { Actor, Artifact, DeckExportFormat } from "@nova/contracts";
import { ORPCError } from "@orpc/server";
import { type EngineArtifactsDeps, emailOf, notFound, toArtifact } from "../artifacts/index.js";

/** Exports a deck; the new file is an artifact in the deck's chat. */
export async function engineExportDeck(
  deps: EngineArtifactsDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  input: { artifactId: string; format: DeckExportFormat },
): Promise<Artifact> {
  try {
    const created = await exportOmnigentDeck(
      client,
      await emailOf(deps, actor),
      input.artifactId,
      input.format,
    );
    return toArtifact(created, null);
  } catch (error) {
    if (error instanceof OmnigentApiError) {
      if (error.code === "runner_unavailable") {
        throw new ORPCError("SERVICE_UNAVAILABLE", {
          message: "Your Computer is still starting. Try again in a moment.",
        });
      }
      if (error.code === "invalid_input") {
        throw new ORPCError("BAD_REQUEST", {
          message: error.detail ?? "That deck couldn't be exported.",
        });
      }
    }
    return notFound(error);
  }
}
