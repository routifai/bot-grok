// `artifacts.*` for Muses whose files the engine owns: a deliverable the Muse saved with
// `artifact_save` (engine/omnigent/omnigent/superchat/artifacts). Nova keeps no rows for these;
// the engine rows are mapped onto the same shapes the Library and preview already speak, with
// the engine's artifact id standing in for both the family id and the version id.
import {
  createChatOwnershipResolver,
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

/** The engine's page cap for `GET /v1/artifacts` (it has no offset). */
const ENGINE_LIST_MAX = 500;
const DEFAULT_LIST_LIMIT = 200;

type OwnerOf = (sessionId: string) => Promise<string | undefined>;

/**
 * Maps an engine session to the Muse it belongs to, for this person. A deliverable is keyed by
 * the chat that saved it (`artifact_save` by a Helper lands on the chat that launched it), so
 * besides a Muse's own Conversation its Side Chats and their Helpers (any depth) count: the
 * adapter's one ownership rule, built once per request. `onlyBotId` limits the map to one Muse.
 * Sessions of no owned Muse resolve to undefined.
 */
async function ownerResolver(
  deps: EngineArtifactsDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  email: string,
  onlyBotId?: string,
): Promise<OwnerOf> {
  const supers = await deps.prisma.omnigentSession.findMany({
    where: { bot: { userId: actor.userId, spaceId: actor.spaceId }, botId: onlyBotId },
    select: { omnigentSessionId: true, botId: true },
  });
  const own = new Map(supers.map((row) => [row.omnigentSessionId, row.botId]));
  const resolve = createChatOwnershipResolver(client, email, supers);
  return async (sessionId) => own.get(sessionId) ?? (await resolve(sessionId))?.botId;
}

async function assertOwnMuse(
  deps: EngineArtifactsDeps,
  actor: Actor,
  botId: string,
): Promise<void> {
  const bot = await deps.prisma.bot.findFirst({
    where: { id: botId, spaceId: actor.spaceId, userId: actor.userId },
    select: { id: true },
  });
  if (!bot) throw new ORPCError("NOT_FOUND", { message: "Muse not found" });
}

async function listWithCounts(
  deps: EngineArtifactsDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  botId: string | undefined,
  limit: number,
): Promise<Array<Artifact & { versionCount: number }>> {
  const email = await emailOf(deps, actor);
  if (botId) await assertOwnMuse(deps, actor, botId);
  // The engine can only scope by one chat, and a Muse's deliverables span its Side Chats and
  // Helpers, so take its newest page and attribute each row.
  const [items, ownerOf] = await Promise.all([
    listOmnigentArtifacts(client, email, undefined, ENGINE_LIST_MAX),
    ownerResolver(deps, client, actor, email, botId),
  ]);
  const owned: Array<Artifact & { versionCount: number }> = [];
  for (const item of items) {
    const owner = await ownerOf(item.parent_session_id);
    if (!owner) continue;
    owned.push({ ...toArtifact(item, owner), versionCount: item.versions });
    if (owned.length === limit) break;
  }
  return owned;
}

export async function engineListArtifacts(
  deps: EngineArtifactsDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  botId: string,
): Promise<Artifact[]> {
  return listWithCounts(deps, client, actor, botId, DEFAULT_LIST_LIMIT);
}

export async function engineListSpaceArtifacts(
  deps: EngineArtifactsDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  input: { botId?: string; limit?: number },
): Promise<{ items: Array<Artifact & { versionCount: number }>; nextCursor: null }> {
  // The engine pages by newest-first cap only, so there is never a next page.
  const items = await listWithCounts(
    deps,
    client,
    actor,
    input.botId,
    input.limit ?? DEFAULT_LIST_LIMIT,
  );
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
  const ownerOf = await ownerResolver(deps, client, actor, email);
  return {
    ...toArtifact(detail, (await ownerOf(detail.parent_session_id)) ?? null),
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
