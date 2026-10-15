// Artifacts on the Omnigent side: deliverable files the Muse saved from its Computer with
// `artifact_save` (engine/omnigent/omnigent/superchat/artifacts/routes.py). Plain fetch client;
// a deliverable is addressed by the id of any of its versions.
import { type OmnigentClientConfig, omnigentHeaders, throwOnError } from "./client.js";

/** One saved version of a deliverable (`artifact_to_response`). */
export interface OmnigentArtifact {
  id: string;
  parent_session_id: string;
  name: string;
  title: string | null;
  kind: string;
  mime: string;
  size: number;
  version: number;
  /** How many versions the deliverable has (1 when listed from a single version). */
  versions: number;
  published: boolean;
  /** Present when the deliverable is published as an app. */
  publish?: OmnigentPublication | null;
  created_at: number;
  updated_at: number | null;
  /** `"ai"` (the Muse saved it), `"manual"` (the person edited it) or `"restore"`. */
  origin?: string;
  /** The version this one was edited from (set on `manual` versions). */
  parent_version_id?: string | null;
  edit_summary?: string | null;
}

export type OmnigentPublishAudience = "owner" | "org" | "link";

/** How many times a published app was opened (`ViewStats` in the engine). */
export interface OmnigentPublishStats {
  opens_total: number;
  unique_viewers: number;
  opens_7d: number;
}

/** The published state of a deliverable (`publication_to_response`). */
export interface OmnigentPublication {
  slug: string;
  url_path: string;
  audience: OmnigentPublishAudience;
  version: number;
  published_at: number;
  updated_at: number | null;
  stats: OmnigentPublishStats;
}

export interface OmnigentArtifactVersion {
  id: string;
  version: number;
  size: number;
  created_at: number;
  origin?: string;
  parent_version_id?: string | null;
  edit_summary?: string | null;
  turn_item_id?: string | null;
  chat_id?: string | null;
}

export interface OmnigentArtifactDetail extends OmnigentArtifact {
  /** Every version, newest first. */
  all_versions: OmnigentArtifactVersion[];
}

function artifactUrl(config: OmnigentClientConfig, id: string, suffix = ""): URL {
  return new URL(`/v1/artifacts/${encodeURIComponent(id)}${suffix}`, config.baseUrl);
}

/** `GET /v1/artifacts` — the newest version of each deliverable, newest first. Scoped to one
 * Conversation with `parentSessionId`, else every deliverable the person owns. */
export async function listOmnigentArtifacts(
  config: OmnigentClientConfig,
  email: string,
  parentSessionId?: string,
  limit = 200,
): Promise<OmnigentArtifact[]> {
  const url = new URL("/v1/artifacts", config.baseUrl);
  if (parentSessionId) url.searchParams.set("parent_session_id", parentSessionId);
  url.searchParams.set("limit", String(limit));
  const response = await fetch(url, { headers: omnigentHeaders(config, email) });
  await throwOnError(response, "list artifacts", config.secrets);
  const body = (await response.json()) as { artifacts?: OmnigentArtifact[] };
  return body.artifacts ?? [];
}

/** `GET /v1/artifacts/{id}` — one version plus all versions of its deliverable. */
export async function getOmnigentArtifact(
  config: OmnigentClientConfig,
  email: string,
  id: string,
): Promise<OmnigentArtifactDetail> {
  const response = await fetch(artifactUrl(config, id), {
    headers: omnigentHeaders(config, email),
  });
  await throwOnError(response, "get artifact", config.secrets);
  return (await response.json()) as OmnigentArtifactDetail;
}

/** `GET /v1/artifacts/{id}/content` — the file's bytes (`version` picks another version). */
export async function fetchOmnigentArtifactContent(
  config: OmnigentClientConfig,
  email: string,
  id: string,
  version?: number,
): Promise<Uint8Array> {
  const url = artifactUrl(config, id, "/content");
  if (version !== undefined) url.searchParams.set("version", String(version));
  const response = await fetch(url, { headers: omnigentHeaders(config, email) });
  await throwOnError(response, "read artifact content", config.secrets);
  return new Uint8Array(await response.arrayBuffer());
}

/** `DELETE /v1/artifacts/{id}` — the deliverable and all its versions. */
export async function deleteOmnigentArtifact(
  config: OmnigentClientConfig,
  email: string,
  id: string,
): Promise<void> {
  const response = await fetch(artifactUrl(config, id), {
    method: "DELETE",
    headers: omnigentHeaders(config, email),
  });
  await throwOnError(response, "delete artifact", config.secrets);
}

/** `POST /v1/artifacts/{id}/restore` — makes that earlier version the newest again (a new
 * `restore` version with its bytes); returns the new version. */
export async function restoreOmnigentArtifact(
  config: OmnigentClientConfig,
  email: string,
  id: string,
): Promise<OmnigentArtifact> {
  const response = await fetch(artifactUrl(config, id, "/restore"), {
    method: "POST",
    headers: omnigentHeaders(config, email),
  });
  await throwOnError(response, "restore artifact", config.secrets);
  return (await response.json()) as OmnigentArtifact;
}

/** One source patch (engine wire format; see engine superchat/decks/patches.py). */
export type OmnigentHtmlPatch =
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
  | { kind: "set-full-source"; source: string; summary?: string };

/** `PATCH /v1/artifacts/{id}/edit` — hand edits of an HTML file (a deck, a page) as source
 * patches, or a text document's whole new text (one `set-full-source`), saved as a new `manual` version. Fails with `artifact_stale` when `baseVersion` is no
 * longer the newest, `conflict` when a patch cannot be applied exactly. */
export async function editOmnigentArtifact(
  config: OmnigentClientConfig,
  email: string,
  id: string,
  baseVersion: number,
  patches: OmnigentHtmlPatch[],
): Promise<OmnigentArtifact> {
  const response = await fetch(artifactUrl(config, id, "/edit"), {
    method: "PATCH",
    headers: omnigentHeaders(config, email),
    body: JSON.stringify({ base_version: baseVersion, patches }),
  });
  await throwOnError(response, "edit artifact", config.secrets);
  return (await response.json()) as OmnigentArtifact;
}

/** `POST /v1/artifacts` — saves bytes as the next version of `name` in a Conversation. */
export async function createOmnigentArtifact(
  config: OmnigentClientConfig,
  email: string,
  input: { parentSessionId: string; name: string; bytes: Uint8Array },
): Promise<OmnigentArtifact> {
  const url = new URL("/v1/artifacts", config.baseUrl);
  url.searchParams.set("parent_session_id", input.parentSessionId);
  url.searchParams.set("name", input.name);
  const response = await fetch(url, {
    method: "POST",
    headers: { ...omnigentHeaders(config, email), "content-type": "application/octet-stream" },
    body: input.bytes as unknown as BodyInit,
  });
  await throwOnError(response, "save artifact", config.secrets);
  return (await response.json()) as OmnigentArtifact;
}
