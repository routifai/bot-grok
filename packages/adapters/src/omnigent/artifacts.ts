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

/** One cell of a table artifact; `v` is null for a formula with no cached value. */
export interface OmnigentTableCell {
  v: string | number | boolean | null;
  f: string | null;
  t: string | null;
  z?: string;
}

export interface OmnigentTableSheet {
  name: string;
  rows: OmnigentTableCell[][];
  frozen_rows: number;
  n_rows: number;
  n_cols: number;
  truncated: boolean;
  col_widths?: Array<number | null>;
}

export interface OmnigentTable {
  artifact_id: string;
  version: number;
  kind: string;
  sheets: OmnigentTableSheet[];
}

export interface OmnigentTableEdit {
  sheet: string;
  row: number;
  col: number;
  value: string | number | boolean | null;
}

/** `PATCH /artifacts/{id}/table` answered 409: the newest version moved on. */
export class OmnigentTableConflictError extends Error {
  constructor() {
    super("The sheet changed since it was opened.");
    this.name = "OmnigentTableConflictError";
  }
}

/** `GET /artifacts/{id}/table` — a CSV / XLSX version as grids. */
export async function getOmnigentTable(
  config: OmnigentClientConfig,
  email: string,
  id: string,
): Promise<OmnigentTable> {
  const response = await fetch(artifactUrl(config, id, "/table"), {
    headers: omnigentHeaders(config, email),
  });
  await throwOnError(response, "read table", config.secrets);
  return (await response.json()) as OmnigentTable;
}

/** `PATCH /artifacts/{id}/table` — cell edits as a new `manual` version. Throws
 * `OmnigentTableConflictError` on 409 (`baseVersion` is stale). */
export async function editOmnigentTable(
  config: OmnigentClientConfig,
  email: string,
  id: string,
  baseVersion: number,
  edits: OmnigentTableEdit[],
): Promise<OmnigentArtifact> {
  const response = await fetch(artifactUrl(config, id, "/table"), {
    method: "PATCH",
    headers: omnigentHeaders(config, email),
    body: JSON.stringify({ base_version: baseVersion, edits }),
  });
  if (response.status === 409) throw new OmnigentTableConflictError();
  await throwOnError(response, "edit table", config.secrets);
  return (await response.json()) as OmnigentArtifact;
}

/** `GET /artifacts/{id}/table/range` — the untrusted-data excerpt of a selection. */
export async function getOmnigentTableRange(
  config: OmnigentClientConfig,
  email: string,
  id: string,
  sheet: string,
  range: string,
): Promise<{ version: number; block: string }> {
  const url = artifactUrl(config, id, "/table/range");
  url.searchParams.set("sheet", sheet);
  url.searchParams.set("range", range);
  const response = await fetch(url, { headers: omnigentHeaders(config, email) });
  await throwOnError(response, "read table range", config.secrets);
  return (await response.json()) as { version: number; block: string };
}

/** `POST /v1/artifacts/{id}/publish` — publish or republish (keeps the address). */
export async function publishOmnigentArtifact(
  config: OmnigentClientConfig,
  email: string,
  id: string,
  body: { audience: OmnigentPublishAudience; version?: number },
): Promise<OmnigentPublication> {
  const response = await fetch(artifactUrl(config, id, "/publish"), {
    method: "POST",
    headers: omnigentHeaders(config, email),
    body: JSON.stringify(body),
  });
  await throwOnError(response, "publish artifact", config.secrets);
  return (await response.json()) as OmnigentPublication;
}

/** `DELETE /v1/artifacts/{id}/publish` — take the app offline. */
export async function unpublishOmnigentArtifact(
  config: OmnigentClientConfig,
  email: string,
  id: string,
): Promise<void> {
  const response = await fetch(artifactUrl(config, id, "/publish"), {
    method: "DELETE",
    headers: omnigentHeaders(config, email),
  });
  await throwOnError(response, "unpublish artifact", config.secrets);
}

/** `GET /v1/artifacts/{id}/publish` — the publish state, or null when not published. */
export async function getOmnigentPublication(
  config: OmnigentClientConfig,
  email: string,
  id: string,
): Promise<OmnigentPublication | null> {
  const response = await fetch(artifactUrl(config, id, "/publish"), {
    headers: omnigentHeaders(config, email),
  });
  await throwOnError(response, "get publish state", config.secrets);
  const body = (await response.json()) as { publish: OmnigentPublication | null };
  return body.publish;
}

/**
 * The identity the engine accepts for `/v1/published/*` (its `OMNIGENT_PUBLISHED_GATEWAY_USER`,
 * routes.py `PUBLISHED_GATEWAY_USER_DEFAULT`). Only the `/apps/<slug>` gateway uses it, after it
 * has checked the viewer against the app's audience.
 */
export function omnigentPublishedGatewayEmail(env: NodeJS.ProcessEnv = process.env): string {
  return env.OMNIGENT_PUBLISHED_GATEWAY_USER?.trim() || "nova-apps-gateway@nova.invalid";
}

export interface OmnigentPublishedApp {
  html: Uint8Array;
  audience: OmnigentPublishAudience;
  /** The owner's engine identity (their email). */
  owner: string;
  version: number;
  title: string;
}

/** `GET /v1/published/{slug}` — the pinned HTML with its audience and owner; null when unknown. */
export async function fetchOmnigentPublishedApp(
  config: OmnigentClientConfig,
  slug: string,
): Promise<OmnigentPublishedApp | null> {
  const url = new URL(`/v1/published/${encodeURIComponent(slug)}`, config.baseUrl);
  const response = await fetch(url, {
    headers: omnigentHeaders(config, omnigentPublishedGatewayEmail()),
  });
  if (response.status === 404) return null;
  await throwOnError(response, "read published app", config.secrets);
  const audience = response.headers.get("x-published-audience");
  if (audience !== "owner" && audience !== "org" && audience !== "link") return null;
  return {
    html: new Uint8Array(await response.arrayBuffer()),
    audience,
    owner: decodeURIComponent(response.headers.get("x-published-owner") ?? ""),
    version: Number(response.headers.get("x-published-version") ?? 1),
    title: decodeURIComponent(response.headers.get("x-published-title") ?? ""),
  };
}

/** `POST /v1/published/{slug}/view` — count one open by an opaque viewer key. */
export async function recordOmnigentPublishedView(
  config: OmnigentClientConfig,
  slug: string,
  viewerKey: string,
): Promise<void> {
  const url = new URL(`/v1/published/${encodeURIComponent(slug)}/view`, config.baseUrl);
  const response = await fetch(url, {
    method: "POST",
    headers: omnigentHeaders(config, omnigentPublishedGatewayEmail()),
    body: JSON.stringify({ viewer_key: viewerKey }),
  });
  await throwOnError(response, "record published view", config.secrets);
}
