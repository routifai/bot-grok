// `knowledge.*`: the person's file search. The index lives in their Computer; the engine relays
// it through the Muse session's `/knowledge/*` routes. Nova keeps no rows: these are thin relays
// with the camelCase shapes, scoped to the caller's Muse session.
import {
  fetchOmnigentPageThumbnail,
  getOmnigentKnowledgeStatus,
  type OmnigentClientConfig,
  reindexOmnigentKnowledge,
  searchOmnigentKnowledge,
} from "@nova/adapters";
import type { Actor, KnowledgeStatus } from "@nova/contracts";
import type { PrismaClient } from "@nova/db";
import { ORPCError } from "@orpc/server";
import { resolveMuseSession } from "../computer/index.js";

export interface EngineKnowledgeDeps {
  prisma: PrismaClient;
}

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
  const { email, sessionId } = await resolveMuseSession(deps, client, actor);
  const status = await getOmnigentKnowledgeStatus(client, email, sessionId);
  return {
    files: status.files.map((file) => ({
      fileId: file.file_id,
      path: file.path,
      name: file.name,
      kind: file.kind,
      state: file.state,
      search: file.search,
      keywordOnlyReason: file.keyword_only_reason,
      pages: file.pages,
      pagesWithoutText: file.pages_without_text,
      error: file.error,
      artifactId: file.artifact_id,
    })),
    embeddings: status.embeddings,
    computer: status.computer,
    updatedAt: status.updated_at,
  };
}

export async function engineKnowledgeSearch(
  deps: EngineKnowledgeDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  input: { query: string; fileIds?: string[]; k?: number },
) {
  const { email, sessionId } = await resolveMuseSession(deps, client, actor);
  const found = await searchOmnigentKnowledge(client, email, sessionId, input);
  return {
    mode: found.mode,
    keywordOnlyReason: found.keyword_only_reason,
    filesIndexing: found.files_indexing,
    filesIndexingNames: found.files_indexing_names ?? [],
    results: found.results.map((hit) => ({
      fileName: hit.file_name,
      fileId: hit.file_id,
      path: hit.path,
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
  input: { fileId: string; page: number },
) {
  const { email, sessionId } = await resolveMuseSession(deps, client, actor);
  const bytes = await fetchOmnigentPageThumbnail(
    client,
    email,
    sessionId,
    input.fileId,
    input.page,
  ).catch(notFound);
  return { contentBase64: Buffer.from(bytes).toString("base64"), mimeType: "image/webp" as const };
}

export async function engineKnowledgeReindex(
  deps: EngineKnowledgeDeps,
  client: OmnigentClientConfig,
  actor: Actor,
) {
  const { email, sessionId } = await resolveMuseSession(deps, client, actor);
  return reindexOmnigentKnowledge(client, email, sessionId);
}
