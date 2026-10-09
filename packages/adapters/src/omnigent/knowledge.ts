// The person's file search on the Omnigent side (engine/omnigent/omnigent/superchat/knowledge):
// which files are indexed, passages by query, and page thumbnails. Plain fetch client.
import { type OmnigentClientConfig, omnigentHeaders, throwOnError } from "./client/core.js";

/** One file's index state (`GET /v1/knowledge/status`). */
export interface OmnigentKnowledgeFile {
  artifact_id: string;
  name: string;
  kind: string;
  state: "indexing" | "searchable" | "failed";
  /** `"keyword"` when the person has no connection that can embed. */
  search: "hybrid" | "keyword";
  keyword_only_reason: string | null;
  pages: number;
  pages_without_text: number;
  error: string | null;
}

export interface OmnigentKnowledgeStatus {
  files: OmnigentKnowledgeFile[];
  embeddings: { available: boolean; reason: string | null };
}

/** One passage a search found (`POST /v1/knowledge/search`). */
export interface OmnigentKnowledgePassage {
  file_name: string;
  artifact_id: string;
  page: number;
  page_end: number;
  score: number;
  heading: string;
  passage: string;
  thumbnail_url: string | null;
}

export interface OmnigentKnowledgeSearch {
  mode: "hybrid" | "keyword";
  keyword_only_reason: string | null;
  files_indexing: number;
  results: OmnigentKnowledgePassage[];
}

/** `GET /v1/knowledge/status` — the caller's files and whether searches can embed. */
export async function getOmnigentKnowledgeStatus(
  config: OmnigentClientConfig,
  email: string,
): Promise<OmnigentKnowledgeStatus> {
  const response = await fetch(new URL("/v1/knowledge/status", config.baseUrl), {
    headers: omnigentHeaders(config, email),
  });
  await throwOnError(response, "get knowledge status", config.secrets);
  return (await response.json()) as OmnigentKnowledgeStatus;
}

/** `POST /v1/knowledge/search` — passages from the caller's files, best first. */
export async function searchOmnigentKnowledge(
  config: OmnigentClientConfig,
  email: string,
  input: { query: string; fileIds?: string[]; k?: number },
): Promise<OmnigentKnowledgeSearch> {
  const response = await fetch(new URL("/v1/knowledge/search", config.baseUrl), {
    method: "POST",
    headers: { ...omnigentHeaders(config, email), "content-type": "application/json" },
    body: JSON.stringify({ query: input.query, file_ids: input.fileIds, k: input.k }),
  });
  await throwOnError(response, "search files", config.secrets);
  return (await response.json()) as OmnigentKnowledgeSearch;
}

/** `GET /v1/knowledge/files/{id}/pages/{n}/thumbnail` — the page's WebP bytes. */
export async function fetchOmnigentPageThumbnail(
  config: OmnigentClientConfig,
  email: string,
  artifactId: string,
  page: number,
): Promise<Uint8Array> {
  const url = new URL(
    `/v1/knowledge/files/${encodeURIComponent(artifactId)}/pages/${page}/thumbnail`,
    config.baseUrl,
  );
  const response = await fetch(url, { headers: omnigentHeaders(config, email) });
  await throwOnError(response, "read page thumbnail", config.secrets);
  return new Uint8Array(await response.arrayBuffer());
}

/** `POST /v1/knowledge/reindex` — re-embed files indexed without embeddings. */
export async function reindexOmnigentKnowledge(
  config: OmnigentClientConfig,
  email: string,
): Promise<{ queued: number }> {
  const response = await fetch(new URL("/v1/knowledge/reindex", config.baseUrl), {
    method: "POST",
    headers: omnigentHeaders(config, email),
  });
  await throwOnError(response, "reindex files", config.secrets);
  return (await response.json()) as { queued: number };
}
