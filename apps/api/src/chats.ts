// Real `chats.*` handlers (packages/contracts/src/rpc.ts, docs/super-chat/WIRING.md slice
// A1): Side Chats and Helpers of a Muse's Super Chat. Nova's API only checks who is asking and
// passes the call through (ADR 0001) — the mapping/ownership logic itself lives in
// packages/adapters/src/omnigent/chats.ts so it can be unit-tested with a mocked Omnigent
// client, same as ./engine-info.ts does for `engine.*`.
import {
  createOmnigentSideChat,
  deriveSideChatTitle,
  getOmnigentContextSummary,
  getOmnigentWorkingProject,
  listOmnigentRelatedChats,
  listOmnigentSessionItems,
  mapOmnigentItemsToMessages,
  mapRelatedChatToSummary,
  mapSideChatCreateToSummary,
  type OmnigentClientConfig,
  OmnigentSideChatError,
  type OwnedSuperChat,
  omnigentClientConfigFromEnv,
  omnigentSuperChatConfigFromEnv,
  postOmnigentMessage,
  redactThreadMessages,
  resolveChatOwnership,
  sideChatStartToWire,
} from "@aiden/adapters";
import type { Actor, ChatSummary, SideChatStart, ThreadMessagePage } from "@aiden/contracts";
import type { PrismaClient } from "@aiden/db";
import { getLogger } from "@aiden/logging";
import { ORPCError } from "@orpc/server";
import { syncEngineTimezone } from "./engine-timezone.js";
import { onSuperChat } from "./omnigent-errors.js";

export interface ChatsDeps {
  prisma: PrismaClient;
}

function requireClient(env: NodeJS.ProcessEnv): OmnigentClientConfig {
  const client = omnigentClientConfigFromEnv(env);
  if (!client) {
    throw new ORPCError("BAD_REQUEST", { message: "Chat is not available right now." });
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
  const related = await onSuperChat(listOmnigentRelatedChats(client, email, superSessionId));
  return related.data.map(mapRelatedChatToSummary);
}

/**
 * Creates the Side Chat and sends its first message. Two failure shapes to handle, both
 * reported by `createOmnigentSideChat` (docs/super-chat/WIRING.md review item 3):
 * - The engine's current behaviour: a non-2xx `OmnigentSideChatError`. When its body still
 *   names a `conversation_id`, the chat exists despite the error — surface the specific
 *   "didn't send" message rather than a generic failure (which would wrongly suggest nothing
 *   happened and invite a duplicate retry from the person).
 * - The engine's upcoming behaviour: a 201 whose body carries `first_message_error` instead of
 *   erroring at all. Retry the post once via the plain events route; if that retry also fails,
 *   log it (already redacted — see `requireClient`/`client.secrets`) and still return the
 *   `ChatSummary`, since the chat exists and the person can just resend in it.
 */
export async function createSideChat(
  deps: ChatsDeps,
  actor: Actor,
  input: { botId: string; start: SideChatStart; text: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<ChatSummary> {
  const client = requireClient(env);
  const superSessionId = await requireSuperChatSessionId(deps, actor, input.botId);
  const email = await actorEmail(deps, actor);
  await syncEngineTimezone(deps.prisma, actor.userId, env);

  let created: Awaited<ReturnType<typeof createOmnigentSideChat>>;
  try {
    created = await createOmnigentSideChat(client, email, superSessionId, {
      start: sideChatStartToWire(input.start),
      title: deriveSideChatTitle(input.text),
      firstMessage: input.text,
    });
  } catch (error) {
    if (error instanceof OmnigentSideChatError && error.conversationId) {
      throw new ORPCError("BAD_GATEWAY", {
        message: "Side chat opened, but the first message didn't send.",
      });
    }
    throw new ORPCError("BAD_GATEWAY", { message: "Could not open a side chat." });
  }

  if (created.first_message_error) {
    try {
      await postOmnigentMessage(client, email, created.conversation_id, input.text);
    } catch (retryError) {
      getLogger().error(
        "omnigent createSideChat: retrying the first message failed, leaving the chat for the person to resend in",
        retryError,
        { botId: input.botId, chatId: created.conversation_id },
      );
    }
  }
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
  const result = await onSuperChat(getOmnigentContextSummary(client, email, superSessionId));
  return { summary: result.summary_body ?? "" };
}

/**
 * Newest page by default; `input.before` (an earlier page's `olderItemCursor`) pages further
 * back (docs/super-chat/WIRING.md review item 2). Fetched `order: "desc"` (Omnigent's cursor
 * pagination is keyset-based off the *newest* end), then reversed so `messages` reads oldest
 * first like every other `ThreadMessagePage`. `olderCursor` (the Nova-native integer-seq field)
 * is always null here — Omnigent items have no such sequence; `olderItemCursor` is the real
 * cursor for this page shape.
 */
export async function getChatMessages(
  deps: ChatsDeps,
  actor: Actor,
  input: { chatId: string; before?: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<ThreadMessagePage> {
  const client = requireClient(env);
  const email = await actorEmail(deps, actor);
  const superChats = await ownedSuperChats(deps, actor);
  const ownership = await resolveChatOwnership(client, email, superChats, input.chatId);
  if (!ownership) throw new ORPCError("NOT_FOUND", { message: "Chat not found" });

  const config = omnigentSuperChatConfigFromEnv(env);
  const page = await onSuperChat(
    listOmnigentSessionItems(client, email, input.chatId, {
      order: "desc",
      limit: config.chatsPageSize,
      before: input.before,
    }),
  );
  // A with-context side chat starts with a copy of the Conversation; show only what
  // follows its seed checkpoint (the context itself is shown in the side chat's header).
  const seedIndex = ownership.seedItemId
    ? page.data.findIndex((item) => item.id === ownership.seedItemId)
    : -1;
  const own = seedIndex === -1 ? page.data : page.data.slice(0, seedIndex);
  const ascending = [...own].reverse();
  const secrets = client.secrets ?? [];
  const oldestItemId = own.at(-1)?.id ?? null;
  const hasOlder = seedIndex === -1 && page.has_more;
  return {
    threadId: input.chatId,
    messages: redactThreadMessages(mapOmnigentItemsToMessages(input.chatId, ascending), secrets),
    olderCursor: null,
    olderItemCursor: hasOlder ? oldestItemId : null,
    running: Boolean(ownership.live),
  };
}

/** The Project this chat has open (ADR 0008): the Conversation, or one of its Side Chats. */
export async function getChatProject(
  deps: ChatsDeps,
  actor: Actor,
  input: { botId: string; chatId?: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ project: { slug: string; name: string } | null }> {
  const client = requireClient(env);
  const email = await actorEmail(deps, actor);
  let sessionId: string;
  if (input.chatId) {
    const ownership = await resolveChatOwnership(
      client,
      email,
      await ownedSuperChats(deps, actor),
      input.chatId,
    );
    if (!ownership) throw new ORPCError("NOT_FOUND", { message: "Chat not found" });
    sessionId = input.chatId;
  } else {
    sessionId = await requireSuperChatSessionId(deps, actor, input.botId);
  }
  return { project: await onSuperChat(getOmnigentWorkingProject(client, email, sessionId)) };
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
  await syncEngineTimezone(deps.prisma, actor.userId, env);
  await postOmnigentMessage(client, email, input.chatId, input.text);
  return { ok: true as const };
}
