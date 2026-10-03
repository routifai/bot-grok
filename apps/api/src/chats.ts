// Real `chats.*` handlers (packages/contracts/src/rpc.ts, docs/super-chat/WIRING.md slice
// A1): Side Chats and Helpers of a Muse's Super Chat. Nova's API only checks who is asking and
// passes the call through (ADR 0001) — the mapping/ownership logic itself lives in
// packages/adapters/src/omnigent/chats.ts so it can be unit-tested with a mocked Omnigent
// client, same as ./engine-info.ts does for `engine.*`.
import {
  createOmnigentSideChat,
  deriveSideChatTitle,
  getOmnigentContextSummary,
  listOmnigentRelatedChats,
  listOmnigentSessionItems,
  mapOmnigentItemsToMessages,
  mapRelatedChatToSummary,
  mapSideChatCreateToSummary,
  type OmnigentClientConfig,
  type OwnedSuperChat,
  omnigentClientConfigFromEnv,
  postOmnigentMessage,
  resolveChatOwnership,
  sideChatStartToWire,
} from "@aiden/adapters";
import type { Actor, ChatSummary, SideChatStart, ThreadMessagePage } from "@aiden/contracts";
import type { PrismaClient } from "@aiden/db";
import { ORPCError } from "@orpc/server";

export interface ChatsDeps {
  prisma: PrismaClient;
}

function requireClient(env: NodeJS.ProcessEnv): OmnigentClientConfig {
  const client = omnigentClientConfigFromEnv(env);
  if (!client) {
    throw new ORPCError("BAD_REQUEST", { message: "Nova is not running on the Omnigent engine" });
  }
  return client;
}

async function actorEmail(deps: ChatsDeps, actor: Actor): Promise<string> {
  const user = await deps.prisma.user.findUnique({
    where: { id: actor.userId },
    select: { email: true },
  });
  if (!user) throw new ORPCError("NOT_FOUND", { message: "Person not found" });
  return user.email;
}

/** The Muse's own Super Chat: the bot must belong to the actor (same isolation rule every
 * other bot-scoped route uses), and it must already have a Conversation on Omnigent. */
async function requireSuperChatSessionId(
  deps: ChatsDeps,
  actor: Actor,
  botId: string,
): Promise<string> {
  const bot = await deps.prisma.bot.findFirst({
    where: { id: botId, spaceId: actor.spaceId, userId: actor.userId },
    select: { id: true },
  });
  if (!bot) throw new ORPCError("NOT_FOUND", { message: "Muse not found" });
  const session = await deps.prisma.omnigentSession.findUnique({
    where: { botId },
    select: { omnigentSessionId: true },
  });
  if (!session) {
    throw new ORPCError("NOT_FOUND", { message: "This Muse has no Conversation yet" });
  }
  return session.omnigentSessionId;
}

/** Every Super Chat the actor owns, for the ownership rule (docs/super-chat/WIRING.md): a bare
 * `chatId` is resolved against all of them, not just one botId the caller happened to pass. */
async function ownedSuperChats(deps: ChatsDeps, actor: Actor): Promise<OwnedSuperChat[]> {
  const rows = await deps.prisma.omnigentSession.findMany({
    where: { bot: { spaceId: actor.spaceId, userId: actor.userId } },
    select: { botId: true, omnigentSessionId: true },
  });
  return rows.map((row) => ({ botId: row.botId, omnigentSessionId: row.omnigentSessionId }));
}

export async function listChats(
  deps: ChatsDeps,
  actor: Actor,
  input: { botId: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<ChatSummary[]> {
  const client = requireClient(env);
  const superSessionId = await requireSuperChatSessionId(deps, actor, input.botId);
  const email = await actorEmail(deps, actor);
  const related = await listOmnigentRelatedChats(client, email, superSessionId);
  return related.data.map(mapRelatedChatToSummary);
}

export async function createSideChat(
  deps: ChatsDeps,
  actor: Actor,
  input: { botId: string; start: SideChatStart; text: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<ChatSummary> {
  const client = requireClient(env);
  const superSessionId = await requireSuperChatSessionId(deps, actor, input.botId);
  const email = await actorEmail(deps, actor);
  const created = await createOmnigentSideChat(client, email, superSessionId, {
    start: sideChatStartToWire(input.start),
    title: deriveSideChatTitle(input.text),
    firstMessage: input.text,
  });
  return mapSideChatCreateToSummary(created, input.text);
}

export async function summaryPreview(
  deps: ChatsDeps,
  actor: Actor,
  input: { botId: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ summary: string }> {
  const client = requireClient(env);
  const superSessionId = await requireSuperChatSessionId(deps, actor, input.botId);
  const email = await actorEmail(deps, actor);
  const result = await getOmnigentContextSummary(client, email, superSessionId);
  return { summary: result.summary ?? "" };
}

export async function getChatMessages(
  deps: ChatsDeps,
  actor: Actor,
  input: { chatId: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<ThreadMessagePage> {
  const client = requireClient(env);
  const email = await actorEmail(deps, actor);
  const superChats = await ownedSuperChats(deps, actor);
  const ownership = await resolveChatOwnership(client, email, superChats, input.chatId);
  if (!ownership) throw new ORPCError("NOT_FOUND", { message: "Chat not found" });

  const page = await listOmnigentSessionItems(client, email, input.chatId, {
    order: "asc",
    limit: 200,
  });
  return {
    threadId: input.chatId,
    messages: mapOmnigentItemsToMessages(input.chatId, page.data),
    olderCursor: null,
  };
}

export async function sendToChat(
  deps: ChatsDeps,
  actor: Actor,
  input: { chatId: string; text: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: true }> {
  const client = requireClient(env);
  const email = await actorEmail(deps, actor);
  const superChats = await ownedSuperChats(deps, actor);
  const ownership = await resolveChatOwnership(client, email, superChats, input.chatId);
  if (!ownership) throw new ORPCError("NOT_FOUND", { message: "Chat not found" });
  if (ownership.kind === "helper") {
    throw new ORPCError("BAD_REQUEST", { message: "Helpers are read-only." });
  }
  await postOmnigentMessage(client, email, input.chatId, input.text);
  return { ok: true as const };
}
