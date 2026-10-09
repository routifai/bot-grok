// `decks.*` for Muses whose files the engine owns: a `.deck.html` exported to PowerPoint or PDF
// in the person's Computer.
import {
  editOmnigentDeck,
  exportOmnigentDeck,
  getOmnigentDeckTheme,
  listOmnigentDeckThemes,
  OmnigentApiError,
  type OmnigentClientConfig,
  OmnigentDeckConflictError,
} from "@nova/adapters";
import type { Actor, Artifact, DeckExportFormat, DeckPatch, DeckTheme } from "@nova/contracts";
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

/** Hand edits as source patches. A stale base and a patch the engine will not apply exactly are
 * both CONFLICT; the message tells the web which (it reloads, or says "ask Nova instead"). */
export async function engineEditDeck(
  deps: EngineArtifactsDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  input: { artifactId: string; baseVersion: number; patches: DeckPatch[] },
): Promise<Artifact> {
  try {
    const created = await editOmnigentDeck(
      client,
      await emailOf(deps, actor),
      input.artifactId,
      input.baseVersion,
      input.patches,
    );
    return toArtifact(created, null);
  } catch (error) {
    if (error instanceof OmnigentDeckConflictError) {
      throw new ORPCError("CONFLICT", { message: error.message });
    }
    if (error instanceof OmnigentApiError && error.code === "invalid_input") {
      throw new ORPCError("BAD_REQUEST", { message: error.detail ?? "That edit isn't allowed." });
    }
    return notFound(error);
  }
}

/** The theme dictionary the deck panel's Theme picker shows. */
export async function engineDeckThemes(
  deps: EngineArtifactsDeps,
  client: OmnigentClientConfig,
  actor: Actor,
): Promise<{ themes: DeckTheme[]; defaultTheme: string }> {
  try {
    const found = await listOmnigentDeckThemes(client, await emailOf(deps, actor));
    return {
      defaultTheme: found.default,
      themes: found.themes.map(({ best_for: bestFor, ...theme }) => ({ ...theme, bestFor })),
    };
  } catch (error) {
    return notFound(error);
  }
}

/** The theme a deck is on (null when it was not built on one). */
export async function engineDeckTheme(
  deps: EngineArtifactsDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  input: { artifactId: string },
): Promise<{ theme: string | null }> {
  try {
    return {
      theme: await getOmnigentDeckTheme(client, await emailOf(deps, actor), input.artifactId),
    };
  } catch (error) {
    return notFound(error);
  }
}
