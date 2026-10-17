import { ORPCError } from "@orpc/server";
import {
  addOmnigentForkToConversation,
  archiveOmnigentSession,
  confineWorkspacePath,
  createOmnigentSideChat,
  getOmnigentArchiving,
  getOmnigentContextSummary,
  getOmnigentSession,
  getOmnigentTranscript,
  getOmnigentWorkingPlace,
  getOmnigentWorkspaceRoot,
  interruptOmnigentSession,
  listOmnigentRelatedChats,
  mapRelatedChatToSummary,
  mapSideChatCreateToSummary,
  mapTranscriptPage,
  markOmnigentRead,
  moveOmnigentSessionForPerson,
  OmnigentApiError,
  OmnigentSideChatError,
  postOmnigentMessage,
  putOmnigentArchiving,
  readTurnImages,
  resetOmnigentSession,
  resolveChatOwnership,
  sideChatStartToWire,
  streamOmnigentFamily,
  unarchiveOmnigentSession,
} from "@superchat/adapters/omnigent/browser";
import {
  type Archiving,
  type ChatSummary,
  type FamilyEvent,
  FORK_ANCHOR_INVALID,
  FORK_TOO_DEEP,
  type SideChatStart,
} from "@superchat/contracts";
import { promptTextForWorkspaceAttachments } from "@superchat/core";
import { engineClient, museSessionId, NO_EMAIL } from "./client";
import { onSuperChat, os } from "./context";
import { validateWorkspaceAttachments, validateWorkspaceFolders } from "./workspace-attachments";

/** Messages per transcript page. */
const CHATS_PAGE_SIZE = 50;

/** The Muse's Conversation session. The web's `botId` is that session's id, so a different one
 * names a Muse this person does not have. */
async function requireMuse(botId: string): Promise<string> {
  const sessionId = await museSessionId();
  if (botId !== sessionId) throw new ORPCError("NOT_FOUND", { message: "Muse not found" });
  return sessionId;
}

/** The family a chat belongs to, if it is one of the Muse's own Side Chats or Helpers. */
async function ownershipOf(chatId: string) {
  const sessionId = await museSessionId();
  return resolveChatOwnership(
    engineClient(),
    NO_EMAIL,
    [{ botId: sessionId, omnigentSessionId: sessionId }],
    chatId,
  );
}

/** A Side Chat (or Fork) of the Muse; `NOT_FOUND` for anything else, so a chat's existence never
 * leaks. Helpers are refused: they are read-only. */
async function requireOwnSideChat(botId: string, chatId: string): Promise<void> {
  const ownership = await ownershipOf(chatId);
  if (!ownership || ownership.botId !== botId || ownership.kind !== "side_chat") {
    throw new ORPCError("NOT_FOUND", { message: "Chat not found" });
  }
}

/** A Side Chat or Helper of the Muse `botId` names. */
async function requireOwnChat(botId: string, chatId: string) {
  const ownership = await ownershipOf(chatId);
  if (!ownership || ownership.botId !== botId) {
    throw new ORPCError("NOT_FOUND", { message: "Chat not found" });
  }
  return ownership;
}

/**
 * Creates the Side Chat and sends its first message. The engine retries the first message itself
 * and, if it still cannot be delivered, answers with the chat and a `first_message_error_code`
 * (mapped onto the summary's `firstMessageErrorCode`, so the person resends in the chat that
 * exists). A non-2xx `OmnigentSideChatError` that still names a `conversation_id` means the chat
 * exists despite the error: surface the specific "didn't send" message rather than a generic
 * failure, which would suggest nothing happened and invite a duplicate.
 */
export async function createSideChat(input: {
  botId: string;
  start: SideChatStart;
  text: string;
  folder?: string;
}): Promise<ChatSummary> {
  const superSessionId = await requireMuse(input.botId);
  if (input.folder !== undefined) return createFolderSideChat(superSessionId, input);
  let created: Awaited<ReturnType<typeof createOmnigentSideChat>>;
  try {
    created = await createOmnigentSideChat(engineClient(), NO_EMAIL, superSessionId, {
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

/**
 * A Side Chat that works in one workspace folder: opened empty, moved into the folder (a path
 * relative to the Conversation's workspace, as the Files browser lists it), then sent its first
 * message, so the first turn already runs there.
 */
async function createFolderSideChat(
  superSessionId: string,
  input: { start: SideChatStart; text: string; folder?: string },
): Promise<ChatSummary> {
  const workspace = await folderWorkspace(superSessionId, input.folder ?? "");
  const client = engineClient();
  let created: Awaited<ReturnType<typeof createOmnigentSideChat>>;
  try {
    created = await createOmnigentSideChat(client, NO_EMAIL, superSessionId, {
      start: sideChatStartToWire(input.start),
    });
  } catch {
    throw new ORPCError("BAD_GATEWAY", { message: "Could not open a side chat." });
  }
  try {
    if (workspace.relative) {
      await moveOmnigentSessionForPerson(
        client,
        NO_EMAIL,
        created.conversation_id,
        workspace.path,
        true,
      );
    }
    await postOmnigentMessage(client, NO_EMAIL, created.conversation_id, input.text);
  } catch {
    throw new ORPCError("BAD_GATEWAY", {
      message: "Side chat opened, but the first message didn't send.",
    });
  }
  return mapSideChatCreateToSummary(created, input.text);
}

/** A workspace folder (relative, as the Files browser lists it; `""` is the whole workspace) as
 * an absolute path under the Muse's workspace root. */
async function folderWorkspace(
  superSessionId: string,
  folder: string,
): Promise<{ relative: string; path: string }> {
  let relative: string;
  try {
    relative = confineWorkspacePath(folder);
  } catch {
    throw new ORPCError("BAD_REQUEST", { message: "That folder is outside the workspace." });
  }
  const root = await getOmnigentWorkspaceRoot(engineClient(), NO_EMAIL, superSessionId);
  if (!root) throw new ORPCError("NOT_FOUND", { message: "No workspace yet" });
  return { relative, path: relative ? `${root}/${relative}` : root };
}

/** The person moves a chat (or the Conversation) to a folder; `null` is the whole workspace. */
async function setChatFolder(input: {
  botId: string;
  chatId?: string;
  folder: string | null;
}): Promise<{ ok: true }> {
  const superSessionId = await requireMuse(input.botId);
  if (input.chatId) await requireOwnSideChat(input.botId, input.chatId);
  const sessionId = input.chatId ?? superSessionId;
  const workspace = await folderWorkspace(superSessionId, input.folder ?? "");
  try {
    await moveOmnigentSessionForPerson(
      engineClient(),
      NO_EMAIL,
      sessionId,
      workspace.path,
      input.folder !== null && workspace.relative !== "",
    );
  } catch (error) {
    if (error instanceof OmnigentApiError && error.code === "invalid_input") {
      throw new ORPCError("BAD_REQUEST", { message: "Superchat can't work in that folder." });
    }
    throw error;
  }
  return { ok: true };
}

/**
 * Opens a Fork of one message (ADR 0010) and sends its first message: the Conversation's
 * message, or (with `chatId`) a fork's own message for a fork of a fork. The engine owns every
 * rule (the depth limit, which messages can anchor a fork, the seed up to the anchor); its two
 * refusals reach the client as their own codes so it can offer a plain Side Chat instead.
 */
export async function createFork(input: {
  botId: string;
  chatId?: string;
  anchorItemId: string;
  text: string;
}): Promise<ChatSummary> {
  let parentId: string;
  if (input.chatId) {
    await requireOwnSideChat(input.botId, input.chatId);
    parentId = input.chatId;
  } else {
    parentId = await requireMuse(input.botId);
  }
  let created: Awaited<ReturnType<typeof createOmnigentSideChat>>;
  try {
    created = await createOmnigentSideChat(engineClient(), NO_EMAIL, parentId, {
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

/** The Conversation (no `chatId`), one of its Side Chats, or a Helper, as the engine's transcript
 * (ADR 0009). Newest page by default; `before` (an earlier page's `olderItemCursor`) pages
 * further back. */
export async function getChatTranscript(input: {
  botId: string;
  chatId?: string;
  before?: string;
  beforeReset?: boolean;
}) {
  let sessionId: string;
  let readOnly = false;
  if (input.chatId) {
    const ownership = await requireOwnChat(input.botId, input.chatId);
    sessionId = input.chatId;
    readOnly = ownership.kind === "helper";
  } else {
    sessionId = await requireMuse(input.botId);
  }
  const page = await onSuperChat(
    getOmnigentTranscript(engineClient(), NO_EMAIL, sessionId, {
      limit: CHATS_PAGE_SIZE,
      before: input.before,
      beforeReset: input.beforeReset,
    }),
  );
  const mapped = mapTranscriptPage(sessionId, page);
  return readOnly ? { ...mapped, readOnly } : mapped;
}

/** The Muse's family stream (Conversation, Side Chats, Helpers), relayed as ids only so the
 * client refetches what changed. Ends when the engine's stream does; the client reconnects and
 * refetches. */
export async function* watchFamily(
  input: { botId: string },
  signal: AbortSignal | undefined,
): AsyncGenerator<FamilyEvent> {
  const superSessionId = await requireMuse(input.botId);
  yield { type: "open" };
  try {
    for await (const frame of streamOmnigentFamily(
      engineClient(),
      NO_EMAIL,
      superSessionId,
      signal,
    )) {
      if (frame.type === "message.done") {
        yield { type: "messageDone", chatId: frame.chat_id, itemId: frame.item_id };
      } else if (frame.type === "message.delivery") {
        yield { type: "messageDelivery", chatId: frame.chat_id, itemId: frame.item_id };
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

/**
 * The person's message to a Side Chat (`chatId`) or, without it, the Muse's Conversation. Attached
 * files are already in the workspace: the message carries one reference line each (the same lines
 * the Conversation shows back as chips) and any image goes to the model as an image. The engine
 * owns delivery: a message sent while a turn runs is steered into it or queued behind it.
 */
export async function sendToChat(input: {
  botId?: string;
  chatId?: string;
  text?: string;
  attachments?: Parameters<typeof validateWorkspaceAttachments>[0];
  folders?: string[];
}): Promise<{ ok: true }> {
  let sessionId: string;
  if (input.chatId) {
    if (!(await ownershipOf(input.chatId))) {
      throw new ORPCError("NOT_FOUND", { message: "Chat not found" });
    }
    sessionId = input.chatId;
  } else if (input.botId) {
    sessionId = await requireMuse(input.botId);
  } else {
    throw new ORPCError("BAD_REQUEST", { message: "Name a chat or a Muse." });
  }
  const text = promptTextForWorkspaceAttachments(
    input.text,
    validateWorkspaceAttachments(input.attachments ?? []),
    validateWorkspaceFolders(input.folders ?? []),
  );
  if (!text) throw new ORPCError("BAD_REQUEST", { message: "Nothing to send." });
  const client = engineClient();
  const images = await readTurnImages(client, NO_EMAIL, sessionId, text);
  // A Helper is read-only: the engine refuses the post (`helper_read_only`).
  await onSuperChat(
    images.length
      ? postOmnigentMessage(client, NO_EMAIL, sessionId, text, images)
      : postOmnigentMessage(client, NO_EMAIL, sessionId, text),
  );
  return { ok: true as const };
}

/** The person's side chat auto-archive setting, as the engine keeps it (ADR 0009). */
function toArchiving(saved: Awaited<ReturnType<typeof getOmnigentArchiving>>): Archiving {
  return {
    sideChatAutoArchiveDays: saved.side_chat_auto_archive_days,
    defaultDays: saved.default_days,
  };
}

export const chatsRouter = {
  chats: {
    list: os.chats.list.handler(async ({ input }) => {
      const superSessionId = await requireMuse(input.botId);
      const related = await onSuperChat(
        listOmnigentRelatedChats(engineClient(), NO_EMAIL, superSessionId),
      );
      return related.data.map(mapRelatedChatToSummary);
    }),
    createSide: os.chats.createSide.handler(({ input }) => createSideChat(input)),
    createFork: os.chats.createFork.handler(({ input }) => createFork(input)),
    // The Fork's one-line summary goes back under its anchor. The engine announces it on the
    // family stream (`chats.changed`, then `message.done`).
    addToConversation: os.chats.addToConversation.handler(async ({ input }) => {
      await requireOwnSideChat(input.botId, input.chatId);
      const added = await onSuperChat(
        addOmnigentForkToConversation(engineClient(), NO_EMAIL, input.chatId, input.summary),
      );
      return { summary: added.summary };
    }),
    archive: os.chats.archive.handler(async ({ input }) => {
      await requireOwnSideChat(input.botId, input.chatId);
      await onSuperChat(archiveOmnigentSession(engineClient(), NO_EMAIL, input.chatId));
      return { ok: true as const };
    }),
    unarchive: os.chats.unarchive.handler(async ({ input }) => {
      await requireOwnSideChat(input.botId, input.chatId);
      await onSuperChat(unarchiveOmnigentSession(engineClient(), NO_EMAIL, input.chatId));
      return { ok: true as const };
    }),
    summaryPreview: os.chats.summaryPreview.handler(async ({ input }) => {
      const superSessionId = await requireMuse(input.botId);
      const result = await onSuperChat(
        getOmnigentContextSummary(engineClient(), NO_EMAIL, superSessionId),
      );
      return { summary: result.summary_body ?? "" };
    }),
    transcript: os.chats.transcript.handler(({ input }) => getChatTranscript(input)),
    // The person has the chat open (a Side Chat, or the Conversation without a `chatId`); moves
    // their engine read baseline so its unread dot clears.
    markRead: os.chats.markRead.handler(async ({ input }) => {
      if (input.chatId) await requireOwnChat(input.botId, input.chatId);
      const sessionId = input.chatId ?? (await requireMuse(input.botId));
      await onSuperChat(markOmnigentRead(engineClient(), NO_EMAIL, sessionId));
      return { ok: true as const };
    }),
    // Clears the Muse's Conversation. The engine refuses while a turn is running; every client
    // then refetches on the family stream's `chat.reset`.
    reset: os.chats.reset.handler(async ({ input }) => {
      const sessionId = await requireMuse(input.botId);
      try {
        await onSuperChat(resetOmnigentSession(engineClient(), NO_EMAIL, sessionId));
      } catch (error) {
        if (error instanceof OmnigentApiError && error.code === "conflict") {
          throw new ORPCError("CONFLICT", { message: "Wait for Superchat to finish, then clear." });
        }
        throw error;
      }
      return { ok: true as const };
    }),
    watch: os.chats.watch.handler(async function* ({ input, signal }) {
      yield* watchFamily(input, signal);
    }),
    send: os.chats.send.handler(({ input }) => sendToChat(input)),
    interrupt: os.chats.interrupt.handler(async ({ input }) => {
      const sessionId = await requireMuse(input.botId);
      await onSuperChat(interruptOmnigentSession(engineClient(), NO_EMAIL, sessionId));
      return { ok: true as const };
    }),
    // The Project this chat has open (ADR 0008), as the engine reports it on the session.
    project: os.chats.project.handler(async ({ input }) => {
      if (input.chatId) {
        const ownership = await ownershipOf(input.chatId);
        if (!ownership) throw new ORPCError("NOT_FOUND", { message: "Chat not found" });
        return { project: ownership.project, folder: ownership.folder, chosen: ownership.chosen };
      }
      const sessionId = await requireMuse(input.botId);
      return onSuperChat(getOmnigentWorkingPlace(engineClient(), NO_EMAIL, sessionId));
    }),
    setFolder: os.chats.setFolder.handler(({ input }) => onSuperChat(setChatFolder(input))),
    archiving: os.chats.archiving.handler(async ({ input }) => {
      await requireMuse(input.botId);
      return toArchiving(await getOmnigentArchiving(engineClient(), NO_EMAIL));
    }),
    updateArchiving: os.chats.updateArchiving.handler(async ({ input }) => {
      await requireMuse(input.botId);
      const saved = await putOmnigentArchiving(engineClient(), NO_EMAIL, {
        side_chat_auto_archive_days: input.sideChatAutoArchiveDays,
      });
      return toArchiving(saved);
    }),
  },
};
