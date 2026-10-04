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
  created_at: number;
  updated_at: number | null;
}

export interface OmnigentArtifactVersion {
  id: string;
  version: number;
  size: number;
  created_at: number;
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
