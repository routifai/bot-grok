// `knowledge.*`: the person's file search, read from the engine (engine/omnigent/omnigent/
// superchat/knowledge). Nova keeps no rows: the engine indexes every file it stores as an artifact
// and answers status, search and page thumbnails; these are thin relays with the camelCase shapes.
import {
  fetchOmnigentPageThumbnail,
  getOmnigentKnowledgeStatus,
  type OmnigentClientConfig,
  reindexOmnigentKnowledge,
  searchOmnigentKnowledge,
} from "@nova/adapters";
import type { Actor, KnowledgeStatus } from "@nova/contracts";
import { ORPCError } from "@orpc/server";
import { type EngineArtifactsDeps, emailOf } from "../artifacts/index.js";

export type EngineKnowledgeDeps = EngineArtifactsDeps;

function notFound(error: unknown): never {
  if (error instanceof Error && /\(404\)/.test(error.message)) {
    throw new ORPCError("NOT_FOUND", { message: "Page not found" });
  }
  throw error;
}

export async function engineKnowledgeStatus(
  deps: EngineKnowledgeDeps,
  client: OmnigentClientConfig,
  actor: Actor,
): Promise<KnowledgeStatus> {
  const status = await getOmnigentKnowledgeStatus(client, await emailOf(deps, actor));
  return {
    files: status.files.map((file) => ({
      artifactId: file.artifact_id,
      name: file.name,
      kind: file.kind,
      state: file.state,
      search: file.search,
      keywordOnlyReason: file.keyword_only_reason,
      pages: file.pages,
      pagesWithoutText: file.pages_without_text,
      error: file.error,
    })),
    embeddings: status.embeddings,
  };
}

export async function engineKnowledgeSearch(
  deps: EngineKnowledgeDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  input: { query: string; fileIds?: string[]; k?: number },
) {
  const found = await searchOmnigentKnowledge(client, await emailOf(deps, actor), input);
  return {
    mode: found.mode,
    keywordOnlyReason: found.keyword_only_reason,
    filesIndexing: found.files_indexing,
    results: found.results.map((hit) => ({
      fileName: hit.file_name,
      artifactId: hit.artifact_id,
      page: hit.page,
      pageEnd: hit.page_end,
      score: hit.score,
      heading: hit.heading,
      passage: hit.passage,
      hasThumbnail: hit.thumbnail_url !== null,
    })),
  };
}

export async function engineKnowledgePageThumbnail(
  deps: EngineKnowledgeDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  input: { artifactId: string; page: number },
) {
  const bytes = await fetchOmnigentPageThumbnail(
    client,
    await emailOf(deps, actor),
    input.artifactId,
    input.page,
  ).catch(notFound);
  return { contentBase64: Buffer.from(bytes).toString("base64"), mimeType: "image/webp" as const };
}

export async function engineKnowledgeReindex(
  deps: EngineKnowledgeDeps,
  client: OmnigentClientConfig,
  actor: Actor,
) {
  return reindexOmnigentKnowledge(client, await emailOf(deps, actor));
}
