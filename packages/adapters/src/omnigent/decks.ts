// Decks on the Omnigent side: a saved `.deck.html` exported to editable PowerPoint or vector PDF
// in the person's Computer (engine/omnigent/omnigent/superchat/decks/routes.py). The result is a
// new artifact row in the deck's chat.
import type { OmnigentArtifact } from "./artifacts.js";
import { type OmnigentClientConfig, omnigentHeaders, throwOnError } from "./client.js";

/** The engine's wake plus the export itself can take a couple of minutes. */
const EXPORT_TIMEOUT_MS = 240_000;

/** `POST /decks/{id}/export` — exports the deck and returns the new artifact. */
export async function exportOmnigentDeck(
  config: OmnigentClientConfig,
  email: string,
  id: string,
  format: "pptx" | "pdf",
): Promise<OmnigentArtifact> {
  const response = await fetch(
    new URL(`/v1/decks/${encodeURIComponent(id)}/export`, config.baseUrl),
    {
      method: "POST",
      headers: omnigentHeaders(config, email),
      body: JSON.stringify({ format }),
      signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS),
    },
  );
  await throwOnError(response, "export deck", config.secrets);
  return (await response.json()) as OmnigentArtifact;
}
