// Real `chats.*` handlers (packages/contracts/src/rpc.ts, docs/super-chat/WIRING.md slice
// A1): Side Chats and Helpers of a Muse's Super Chat. Nova's API only checks who is asking and
// passes the call through (ADR 0001) — the mapping/ownership logic itself lives in
// packages/adapters/src/omnigent/chats.ts so it can be unit-tested with a mocked Omnigent
// client, same as ./engine-info.ts does for `engine.*`.
import {
  createOmnigentSideChat,
  deriveSideChatTitle,
  getOmnigentContextSummary,
  getOmnigentTranscript,
  getOmnigentWorkingProject,
  listOmnigentRelatedChats,
  mapRelatedChatToSummary,
  mapSideChatCreateToSummary,
  mapTranscriptPage,
  type OmnigentClientConfig,
  OmnigentSideChatError,
  type OwnedSuperChat,
  omnigentClientConfigFromEnv,
  omnigentSuperChatConfigFromEnv,
  postOmnigentMessage,
  resolveChatOwnership,
  sideChatStartToWire,
  streamOmnigentFamily,
} from "@aiden/adapters";
import type {
  Actor,
  ChatSummary,
  FamilyEvent,
  SideChatStart,
  ThreadMessagePage,
} from "@aiden/contracts";
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
 * The Conversation (no `chatId`), one of its Side Chats, or a Helper, as the engine's transcript
 * (ADR 0009). Newest page by default; `input.before` (an earlier page's `olderItemCursor`) pages
 * further back. The engine owns every rule (de-duping, system notices, a Side Chat's seed); this
 * only checks who is asking and maps the page onto the chat's block types.
 */
export async function getChatTranscript(
  deps: ChatsDeps,
  actor: Actor,
  input: { botId: string; chatId?: string; before?: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<ThreadMessagePage> {
  const client = requireClient(env);
  const email = await actorEmail(deps, actor);
  let sessionId: string;
  let running: boolean | undefined;
  if (input.chatId) {
    const ownership = await resolveChatOwnership(
      client,
      email,
      await ownedSuperChats(deps, actor),
      input.chatId,
    );
    if (!ownership || ownership.botId !== input.botId) {
      throw new ORPCError("NOT_FOUND", { message: "Chat not found" });
    }
    sessionId = input.chatId;
    running = ownership.kind === "side_chat" ? Boolean(ownership.live) : undefined;
  } else {
    sessionId = await requireSuperChatSessionId(deps, actor, input.botId);
  }
  const config = omnigentSuperChatConfigFromEnv(env);
  const page = await onSuperChat(
    getOmnigentTranscript(client, email, sessionId, {
      limit: config.chatsPageSize,
      before: input.before,
    }),
  );
  return mapTranscriptPage(sessionId, page, client.secrets ?? [], running);
}

/** `chats.watch`: the Muse's family stream (Conversation, Side Chats, Helpers), relayed as ids
 * only so the client refetches what changed. Ends when the engine's stream does; the client
 * reconnects and refetches. */
export async function* watchFamily(
  deps: ChatsDeps,
  actor: Actor,
  input: { botId: string },
  signal: AbortSignal | undefined,
  env: NodeJS.ProcessEnv = process.env,
): AsyncGenerator<FamilyEvent> {
  const client = requireClient(env);
  const superSessionId = await requireSuperChatSessionId(deps, actor, input.botId);
  const email = await actorEmail(deps, actor);
  yield { type: "open" };
  try {
    for await (const frame of streamOmnigentFamily(client, email, superSessionId, signal)) {
      if (frame.type === "message.done") {
        yield { type: "messageDone", chatId: frame.chat_id, itemId: frame.item_id };
      } else if (frame.type === "turn.done") {
        yield { type: "turnDone", chatId: frame.chat_id, status: frame.status };
      } else if (frame.type === "chats.changed") yield { type: "chatsChanged" };
      else if (frame.type === "activities.changed") yield { type: "activitiesChanged" };
      else yield { type: "heartbeat" };
    }
  } catch (error) {
    // A closed tab aborts the fetch; that is the normal end of a watch, not a failure.
    if (!signal?.aborted) throw error;
  }
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
