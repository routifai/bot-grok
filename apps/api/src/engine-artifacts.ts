// `artifacts.*` for Muses whose files the engine owns: a deliverable the Muse saved with
// `artifact_save` (engine/omnigent/omnigent/superchat/artifacts). Nova keeps no rows for these;
// the engine rows are mapped onto the same shapes the Library and preview already speak, with
// the engine's artifact id standing in for both the family id and the version id.
import {
  deleteOmnigentArtifact,
  fetchOmnigentArtifactContent,
  getOmnigentArtifact,
  listOmnigentArtifacts,
  type OmnigentArtifact,
  type OmnigentClientConfig,
} from "@aiden/adapters";
import type { Actor, Artifact, ArtifactVersion, ArtifactWithContent } from "@aiden/contracts";
import type { PrismaClient } from "@aiden/db";
import { ORPCError } from "@orpc/server";

export interface EngineArtifactsDeps {
  prisma: PrismaClient;
}

const iso = (epochSeconds: number): string => new Date(epochSeconds * 1000).toISOString();

/** The served content type without parameters (`text/html; charset=utf-8` -> `text/html`). */
const baseMime = (mime: string): string => mime.split(";")[0]?.trim() || mime;

async function emailOf(deps: EngineArtifactsDeps, actor: Actor): Promise<string> {
  const user = await deps.prisma.user.findUnique({
    where: { id: actor.userId },
    select: { email: true },
  });
  if (!user) throw new ORPCError("UNAUTHORIZED");
  return user.email;
}

function toArtifact(item: OmnigentArtifact, botId: string | null): Artifact {
  return {
    id: item.id,
    botId,
    groupId: null,
    runId: null,
    name: item.name,
    description: item.title,
    mimeType: baseMime(item.mime),
    size: item.size,
    version: item.version,
    createdAt: iso(item.created_at),
  };
}

/** Maps engine Conversation ids to this person's Muse ids (for artifacts listed across Muses). */
async function botIdsBySession(
  deps: EngineArtifactsDeps,
  actor: Actor,
  sessionIds: string[],
): Promise<Map<string, string>> {
  if (sessionIds.length === 0) return new Map();
  const rows = await deps.prisma.omnigentSession.findMany({
    where: {
      omnigentSessionId: { in: sessionIds },
      bot: { userId: actor.userId, spaceId: actor.spaceId },
    },
    select: { omnigentSessionId: true, botId: true },
  });
  return new Map(rows.map((row) => [row.omnigentSessionId, row.botId]));
}

async function sessionOf(
  deps: EngineArtifactsDeps,
  actor: Actor,
  botId: string,
): Promise<string | null> {
  const bot = await deps.prisma.bot.findFirst({
    where: { id: botId, spaceId: actor.spaceId, userId: actor.userId },
    select: { id: true, omnigentSession: { select: { omnigentSessionId: true } } },
  });
  if (!bot) throw new ORPCError("NOT_FOUND", { message: "Muse not found" });
  return bot.omnigentSession?.omnigentSessionId ?? null;
}

async function listWithCounts(
  deps: EngineArtifactsDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  botId: string | undefined,
  limit: number,
): Promise<Array<Artifact & { versionCount: number }>> {
  const email = await emailOf(deps, actor);
  let sessionId: string | undefined;
  if (botId) {
    const found = await sessionOf(deps, actor, botId);
    if (!found) return [];
    sessionId = found;
  }
  const items = await listOmnigentArtifacts(client, email, sessionId, limit);
  const bots = botId
    ? new Map<string, string>()
    : await botIdsBySession(deps, actor, [...new Set(items.map((i) => i.parent_session_id))]);
  return items.map((item) => ({
    ...toArtifact(item, botId ?? bots.get(item.parent_session_id) ?? null),
    versionCount: item.versions,
  }));
}

export async function engineListArtifacts(
  deps: EngineArtifactsDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  botId: string,
): Promise<Artifact[]> {
  return listWithCounts(deps, client, actor, botId, 200);
}

export async function engineListSpaceArtifacts(
  deps: EngineArtifactsDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  input: { botId?: string; limit?: number },
): Promise<{ items: Array<Artifact & { versionCount: number }>; nextCursor: null }> {
  // The engine returns the newest deliverables up to the cap in one page.
  const items = await listWithCounts(deps, client, actor, input.botId, 200);
  return { items, nextCursor: null };
}

export async function engineListArtifactVersions(
  deps: EngineArtifactsDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  familyId: string,
): Promise<ArtifactVersion[]> {
  const detail = await getOmnigentArtifact(client, await emailOf(deps, actor), familyId).catch(
    notFound,
  );
  return detail.all_versions.map((version) => ({
    id: version.id,
    version: version.version,
    name: detail.name,
    createdAt: iso(version.created_at),
  }));
}

export async function engineGetArtifact(
  deps: EngineArtifactsDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  artifactId: string,
): Promise<ArtifactWithContent> {
  const email = await emailOf(deps, actor);
  const detail = await getOmnigentArtifact(client, email, artifactId).catch(notFound);
  const bytes = await fetchOmnigentArtifactContent(client, email, artifactId);
  const bots = await botIdsBySession(deps, actor, [detail.parent_session_id]);
  return {
    ...toArtifact(detail, bots.get(detail.parent_session_id) ?? null),
    contentBase64: Buffer.from(bytes).toString("base64"),
  };
}

export async function engineRemoveArtifact(
  deps: EngineArtifactsDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  artifactId: string,
): Promise<{ ok: true }> {
  await deleteOmnigentArtifact(client, await emailOf(deps, actor), artifactId).catch(notFound);
  return { ok: true as const };
}

function notFound(error: unknown): never {
  if (error instanceof Error && /\(404\)/.test(error.message)) {
    throw new ORPCError("NOT_FOUND", { message: "Artifact not found" });
  }
  throw error;
}
