// Real `chats.*` handlers (packages/contracts/src/rpc.ts, docs/super-chat/WIRING.md slice
// A1): Side Chats and Helpers of a Muse's Super Chat. Nova's API only checks who is asking and
// passes the call through (ADR 0001) — the mapping/ownership logic itself lives in
// packages/adapters/src/omnigent/chats.ts so it can be unit-tested with a mocked Omnigent
// client, same as ./engine-info.ts does for `engine.*`.
import {
  addOmnigentForkToConversation,
  archiveOmnigentSession,
  createOmnigentSideChat,
  getOmnigentContextSummary,
  getOmnigentTranscript,
  getOmnigentWorkingProject,
  listOmnigentRelatedChats,
  mapRelatedChatToSummary,
  mapSideChatCreateToSummary,
  mapTranscriptPage,
  markOmnigentRead,
  OmnigentApiError,
  type OmnigentClientConfig,
  OmnigentSideChatError,
  type OwnedSuperChat,
  omnigentClientConfigFromEnv,
  omnigentClientFor,
  omnigentSuperChatConfigFromEnv,
  postOmnigentMessage,
  resetOmnigentSession,
  resolveChatOwnership,
  sideChatStartToWire,
  streamOmnigentFamily,
  unarchiveOmnigentSession,
} from "@aiden/adapters";
import {
  type Actor,
  type ChatSummary,
  type FamilyEvent,
  FORK_ANCHOR_INVALID,
  FORK_TOO_DEEP,
  type SideChatStart,
  type ThreadMessagePage,
} from "@aiden/contracts";
import type { PrismaClient } from "@aiden/db";
import { ORPCError } from "@orpc/server";
import { syncEngineTimezone } from "./engine-timezone.js";
import { onSuperChat } from "./omnigent-errors.js";

export interface ChatsDeps {
  prisma: PrismaClient;
}

/** The engine client for the actor's space (the tenant every engine call carries). */
function requireClient(env: NodeJS.ProcessEnv, actor: Actor): OmnigentClientConfig {
  const connection = omnigentClientConfigFromEnv(env);
  if (!connection) {
    throw new ORPCError("BAD_REQUEST", { message: "Chat is not available right now." });
  }
  return omnigentClientFor(connection, actor.spaceId);
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
  const client = requireClient(env, actor);
  const superSessionId = await requireSuperChatSessionId(deps, actor, input.botId);
  const email = await actorEmail(deps, actor);
  const related = await onSuperChat(listOmnigentRelatedChats(client, email, superSessionId));
  return related.data.map(mapRelatedChatToSummary);
}

/**
 * Creates the Side Chat and sends its first message. The engine retries the first message itself
 * and, if it still cannot be delivered, answers with the chat and a `first_message_error_code`
 * (mapped onto the summary's `firstMessageErrorCode`, so the person resends in the chat that
 * exists). A non-2xx `OmnigentSideChatError` that still names a `conversation_id` means the chat
 * exists despite the error: surface the specific "didn't send" message rather than a generic
 * failure, which would suggest nothing happened and invite a duplicate.
 */
export async function createSideChat(
  deps: ChatsDeps,
  actor: Actor,
  input: { botId: string; start: SideChatStart; text: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<ChatSummary> {
  const client = requireClient(env, actor);
  const superSessionId = await requireSuperChatSessionId(deps, actor, input.botId);
  const email = await actorEmail(deps, actor);
  await syncEngineTimezone(deps.prisma, actor, env);

  let created: Awaited<ReturnType<typeof createOmnigentSideChat>>;
  try {
    created = await createOmnigentSideChat(client, email, superSessionId, {
      start: sideChatStartToWire(input.start),
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

  return mapSideChatCreateToSummary(created, input.text);
}

/** A Side Chat (or Fork) the actor's Muse `botId` owns; `NOT_FOUND` for anything else, so a
 * chat's existence never leaks. Helpers are refused: they are read-only. */
async function requireOwnSideChat(
  deps: ChatsDeps,
  actor: Actor,
  client: OmnigentClientConfig,
  email: string,
  botId: string,
  chatId: string,
): Promise<void> {
  const ownership = await resolveChatOwnership(
    client,
    email,
    await ownedSuperChats(deps, actor),
    chatId,
  );
  if (!ownership || ownership.botId !== botId || ownership.kind !== "side_chat") {
    throw new ORPCError("NOT_FOUND", { message: "Chat not found" });
  }
}

/**
 * Opens a Fork of one message (ADR 0010) and sends its first message: the Conversation's
 * message, or (with `chatId`) a fork's own message for a fork of a fork. The engine owns every
 * rule (the depth limit, which messages can anchor a fork, the seed up to the anchor); its two
 * refusals reach the client as their own codes so it can offer a plain Side Chat instead.
 */
export async function createFork(
  deps: ChatsDeps,
  actor: Actor,
  input: { botId: string; chatId?: string; anchorItemId: string; text: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<ChatSummary> {
  const client = requireClient(env, actor);
  const email = await actorEmail(deps, actor);
  let parentId: string;
  if (input.chatId) {
    await requireOwnSideChat(deps, actor, client, email, input.botId, input.chatId);
    parentId = input.chatId;
  } else {
    parentId = await requireSuperChatSessionId(deps, actor, input.botId);
  }
  await syncEngineTimezone(deps.prisma, actor, env);

  let created: Awaited<ReturnType<typeof createOmnigentSideChat>>;
  try {
    created = await createOmnigentSideChat(client, email, parentId, {
      start: "with_context",
      firstMessage: input.text,
      anchorItemId: input.anchorItemId,
    });
  } catch (error) {
    if (error instanceof OmnigentSideChatError) {
      if (error.code === "fork_too_deep") {
        throw new ORPCError(FORK_TOO_DEEP, { status: 422, message: "This fork can't be forked." });
      }
      if (error.code === "fork_anchor_invalid") {
        throw new ORPCError(FORK_ANCHOR_INVALID, {
          status: 422,
          message: "This message can't be forked.",
        });
      }
      if (error.conversationId) {
        throw new ORPCError("BAD_GATEWAY", {
          message: "Fork opened, but the first message didn't send.",
        });
      }
    }
    throw new ORPCError("BAD_GATEWAY", { message: "Could not open a fork." });
  }
  return mapSideChatCreateToSummary(created, input.text);
}

/** `chats.addToConversation`: the Fork's one-line summary goes back under its anchor. The
 * engine announces it on the family stream (`chats.changed`, then `message.done`). */
export async function addForkToConversation(
  deps: ChatsDeps,
  actor: Actor,
  input: { botId: string; chatId: string; summary?: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ summary: string }> {
  const client = requireClient(env, actor);
  const email = await actorEmail(deps, actor);
  await requireOwnSideChat(deps, actor, client, email, input.botId, input.chatId);
  const added = await onSuperChat(
    addOmnigentForkToConversation(client, email, input.chatId, input.summary),
  );
  return { summary: added.summary };
}

/** `chats.archive`: the Side Chat archive, on the person's request. */
export async function archiveChat(
  deps: ChatsDeps,
  actor: Actor,
  input: { botId: string; chatId: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: true }> {
  const client = requireClient(env, actor);
  const email = await actorEmail(deps, actor);
  await requireOwnSideChat(deps, actor, client, email, input.botId, input.chatId);
  await onSuperChat(archiveOmnigentSession(client, email, input.chatId));
  return { ok: true as const };
}

/** `chats.unarchive`: restores an archived Side Chat or Fork. */
export async function unarchiveChat(
  deps: ChatsDeps,
  actor: Actor,
  input: { botId: string; chatId: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: true }> {
  const client = requireClient(env, actor);
  const email = await actorEmail(deps, actor);
  await requireOwnSideChat(deps, actor, client, email, input.botId, input.chatId);
  await onSuperChat(unarchiveOmnigentSession(client, email, input.chatId));
  return { ok: true as const };
}

export async function summaryPreview(
  deps: ChatsDeps,
  actor: Actor,
  input: { botId: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ summary: string }> {
  const client = requireClient(env, actor);
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
  input: { botId: string; chatId?: string; before?: string; beforeReset?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): Promise<ThreadMessagePage> {
  const client = requireClient(env, actor);
  const email = await actorEmail(deps, actor);
  let sessionId: string;
  let readOnly = false;
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
    readOnly = ownership.kind === "helper";
  } else {
    sessionId = await requireSuperChatSessionId(deps, actor, input.botId);
  }
  const config = omnigentSuperChatConfigFromEnv(env);
  const page = await onSuperChat(
    getOmnigentTranscript(client, email, sessionId, {
      limit: config.chatsPageSize,
      before: input.before,
      beforeReset: input.beforeReset,
    }),
  );
  const mapped = mapTranscriptPage(sessionId, page);
  return readOnly ? { ...mapped, readOnly } : mapped;
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
  const client = requireClient(env, actor);
  const superSessionId = await requireSuperChatSessionId(deps, actor, input.botId);
  const email = await actorEmail(deps, actor);
  yield { type: "open" };
  try {
    for await (const frame of streamOmnigentFamily(client, email, superSessionId, signal)) {
      if (frame.type === "message.done") {
        yield { type: "messageDone", chatId: frame.chat_id, itemId: frame.item_id };
      } else if (frame.type === "chat.reset") {
        yield { type: "chatReset", chatId: frame.chat_id, itemId: frame.item_id };
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

/** The Project this chat has open (ADR 0008), as the engine reports it on the session: the
 * Conversation, or one of its Side Chats. */
export async function getChatProject(
  deps: ChatsDeps,
  actor: Actor,
  input: { botId: string; chatId?: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ project: { slug: string; name: string } | null }> {
  const client = requireClient(env, actor);
  const email = await actorEmail(deps, actor);
  if (input.chatId) {
    const ownership = await resolveChatOwnership(
      client,
      email,
      await ownedSuperChats(deps, actor),
      input.chatId,
    );
    if (!ownership) throw new ORPCError("NOT_FOUND", { message: "Chat not found" });
    return { project: ownership.project };
  }
  const sessionId = await requireSuperChatSessionId(deps, actor, input.botId);
  return { project: await onSuperChat(getOmnigentWorkingProject(client, email, sessionId)) };
}

/** `chats.markRead`: the person has the chat open (a Side Chat, or the Conversation without a
 * `chatId`); moves their engine read baseline so its unread dot clears. */
export async function markChatRead(
  deps: ChatsDeps,
  actor: Actor,
  input: { botId: string; chatId?: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: true }> {
  const client = requireClient(env, actor);
  const email = await actorEmail(deps, actor);
  let sessionId: string;
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
  } else {
    sessionId = await requireSuperChatSessionId(deps, actor, input.botId);
  }
  await onSuperChat(markOmnigentRead(client, email, sessionId));
  return { ok: true as const };
}

/** `chats.reset`: clears the Muse's Conversation on the engine (owner only; it refuses with a
 * conflict while a turn is running, which surfaces as `CONFLICT`). Every client then refetches
 * on the family stream's `chat.reset`. */
export async function resetConversation(
  deps: ChatsDeps,
  actor: Actor,
  input: { botId: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: true }> {
  const client = requireClient(env, actor);
  const email = await actorEmail(deps, actor);
  const sessionId = await requireSuperChatSessionId(deps, actor, input.botId);
  try {
    await onSuperChat(resetOmnigentSession(client, email, sessionId));
  } catch (error) {
    if (error instanceof OmnigentApiError && error.code === "conflict") {
      throw new ORPCError("CONFLICT", { message: "Wait for Nova to finish, then clear." });
    }
    throw error;
  }
  return { ok: true as const };
}

export async function sendToChat(
  deps: ChatsDeps,
  actor: Actor,
  input: { chatId: string; text: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: true }> {
  const client = requireClient(env, actor);
  const email = await actorEmail(deps, actor);
  const superChats = await ownedSuperChats(deps, actor);
  const ownership = await resolveChatOwnership(client, email, superChats, input.chatId);
  if (!ownership) throw new ORPCError("NOT_FOUND", { message: "Chat not found" });
  await syncEngineTimezone(deps.prisma, actor, env);
  // A Helper is read-only: the engine refuses the post (`helper_read_only`).
  await onSuperChat(postOmnigentMessage(client, email, input.chatId, input.text));
  return { ok: true as const };
}
