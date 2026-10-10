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

/** One theme of the dictionary (`GET /decks/themes`). */
export interface OmnigentDeckTheme {
  id: string;
  name: string;
  /** Two to four words: what a picker tile says under the thumbnail. */
  tagline: string;
  mood: string;
  category: "professional" | "editorial" | "bold" | "dark";
  mode: "light" | "dark";
  best_for: string;
  preview: string;
}

/** `GET /decks/themes` — the deck theme dictionary with thumbnails. */
export async function listOmnigentDeckThemes(
  config: OmnigentClientConfig,
  email: string,
): Promise<{ themes: OmnigentDeckTheme[]; default: string }> {
  const response = await fetch(new URL("/v1/decks/themes", config.baseUrl), {
    headers: omnigentHeaders(config, email),
  });
  await throwOnError(response, "list deck themes", config.secrets);
  return (await response.json()) as { themes: OmnigentDeckTheme[]; default: string };
}

/** `GET /decks/themes/{id}/sample` — the kit's sample deck built in one theme (a `.deck.html`),
 * for a theme preview. */
export async function getOmnigentDeckThemeSample(
  config: OmnigentClientConfig,
  email: string,
  themeId: string,
): Promise<string> {
  const response = await fetch(
    new URL(`/v1/decks/themes/${encodeURIComponent(themeId)}/sample`, config.baseUrl),
    { headers: omnigentHeaders(config, email) },
  );
  await throwOnError(response, "read deck theme sample", config.secrets);
  return ((await response.json()) as { html: string }).html;
}

/** `GET /decks/{id}/theme` — the theme id a deck is on, `null` when hand-made. */
export async function getOmnigentDeckTheme(
  config: OmnigentClientConfig,
  email: string,
  id: string,
): Promise<string | null> {
  const response = await fetch(
    new URL(`/v1/decks/${encodeURIComponent(id)}/theme`, config.baseUrl),
    {
      headers: omnigentHeaders(config, email),
    },
  );
  await throwOnError(response, "read deck theme", config.secrets);
  return ((await response.json()) as { theme: string | null }).theme;
}

/** One source patch (engine wire format; see engine superchat/decks/patches.py). */
export type OmnigentDeckPatch =
  | { kind: "set-text"; id: string; text: string }
  | {
      kind: "set-style";
      id: string;
      style: Record<string, string | null>;
      before?: Record<string, string>;
    }
  | {
      kind: "set-attributes";
      id: string;
      attributes: { href?: string | null; alt?: string | null };
    }
  | { kind: "remove-element"; id: string }
  | { kind: "duplicate-element"; id: string }
  | { kind: "set-theme"; theme: string }
  | { kind: "set-full-source"; source: string };

/** `PATCH /artifacts/{id}/edit` answered 409: a stale base, or a patch the engine would not apply
 * exactly (`message` says which). */
export class OmnigentDeckConflictError extends Error {
  constructor(
    message: string,
    readonly stale: boolean,
  ) {
    super(message);
    this.name = "OmnigentDeckConflictError";
  }
}

/** `PATCH /artifacts/{id}/edit` — source patches as a new `manual` version. */
export async function editOmnigentDeck(
  config: OmnigentClientConfig,
  email: string,
  id: string,
  baseVersion: number,
  patches: OmnigentDeckPatch[],
): Promise<OmnigentArtifact> {
  const response = await fetch(
    new URL(`/v1/artifacts/${encodeURIComponent(id)}/edit`, config.baseUrl),
    {
      method: "PATCH",
      headers: omnigentHeaders(config, email),
      body: JSON.stringify({ base_version: baseVersion, patches }),
    },
  );
  if (response.status === 409) {
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    const message = body?.error?.message ?? "The deck changed.";
    throw new OmnigentDeckConflictError(message, /^The deck changed since/.test(message));
  }
  await throwOnError(response, "edit deck", config.secrets);
  return (await response.json()) as OmnigentArtifact;
}
