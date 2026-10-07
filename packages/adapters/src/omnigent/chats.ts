// Super Chat Side Chats and Helpers (CONTEXT.md "Side Chat", "Helper"; docs/super-chat/
// WIRING.md "chats.*"): mapping between Omnigent's related_chats/side_chats shapes and
// Nova's ChatSummary contract (the transcript is ./transcript.ts), plus the ownership rule that lets apps/api
// resolve a bare chatId to the Super Chat (bot) it belongs to before ever trusting it. Every
// Omnigent call is injected through ./client.js's typed functions, so ./chats.test.ts mocks
// fetch the same way ./gateway.test.ts does — no network, no database.
import type { ChatSummary, SideChatStart } from "@aiden/contracts";
import { isSessionNotFoundError } from "./client/core.js";
import {
  getOmnigentSession,
  listOmnigentRelatedChats,
  type OmnigentClientConfig,
  type OmnigentRelatedChat,
  type OmnigentSideChatCreateResponse,
} from "./client.js";

/** `rollover/SUPERSIDE-CHAT.md` "Nesting": a Helper may coordinate one more level of Helpers,
 * launched from the Super Chat or from a Side Chat — so the longest real chain is Super Chat ->
 * Side Chat -> Helper -> nested Helper, three hops from the nested Helper back to the Super
 * Chat. docs/super-chat/WIRING.md's ownership rule caps the walk here. */
const HELPER_CHAIN_MAX_HOPS = 3;
const SIDE_CHAT_TITLE_MAX_CHARS = 40;

export function sideChatStartToWire(start: SideChatStart): "with_context" | "blank" {
  return start === "withContext" ? "with_context" : "blank";
}

function epochSecondsToIso(epochSeconds: number | null | undefined): string {
  return new Date((epochSeconds ?? 0) * 1000).toISOString();
}

/** `related_chats` entry -> `ChatSummary` (docs/super-chat/WIRING.md: `start` "with_context" ->
 * "withContext"; a missing/null `start` — a Side Chat created before E1 stamped it — also reads
 * as "withContext", the pre-existing default behaviour). */
export function mapRelatedChatToSummary(raw: OmnigentRelatedChat): ChatSummary {
  return {
    id: raw.id,
    title: raw.title ?? "",
    start: raw.start === "blank" ? "blank" : "withContext",
    summary: raw.summary_body || null,
    archived: Boolean(raw.archived),
    live: Boolean(raw.live),
    updatedAt: epochSecondsToIso(raw.updated_at),
  };
}

/** First ~40 characters of the opening message, the Side Chat's title when nothing else names
 * it (there is no "name your Side Chat" input today). */
export function deriveSideChatTitle(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= SIDE_CHAT_TITLE_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, SIDE_CHAT_TITLE_MAX_CHARS).trimEnd()}…`;
}

/** `POST .../side_chats` response -> `ChatSummary`. The create response itself is minimal
 * (`conversation_id`/`title`/`start` only — no `summary`/`archived`/`live`), so this fills in
 * what's true of anything freshly created: not archived, currently live (it was just given a
 * first message), and no seed summary surfaced back here (the "Knows our conversation" hover
 * reads that separately via `chats.summaryPreview`). */
export function mapSideChatCreateToSummary(
  created: OmnigentSideChatCreateResponse,
  firstMessageText: string,
): ChatSummary {
  return {
    id: created.conversation_id,
    title: created.title || deriveSideChatTitle(firstMessageText),
    start: created.start === "blank" ? "blank" : "withContext",
    summary: null,
    archived: false,
    live: true,
    updatedAt: new Date().toISOString(),
  };
}

export type ChatOwnershipKind = "side_chat" | "helper";

export interface ChatOwnership {
  kind: ChatOwnershipKind;
  /** The caller's Super Chat `chatId` resolves under. */
  superSessionId: string;
  botId: string;
  /** A side chat's turn is running right now. */
  live?: boolean;
}

export interface OwnedSuperChat {
  botId: string;
  omnigentSessionId: string;
}

export type ChatOwnershipResolver = (chatId: string) => Promise<ChatOwnership | null>;

/**
 * The ownership rule (docs/super-chat/WIRING.md "Identity and ownership"): `chatId` must be a
 * Side Chat of one of the caller's own Super Chats (`related_chats`), or a Helper whose
 * `parent_session_id` chain reaches one within `HELPER_CHAIN_MAX_HOPS` hops. The resolver
 * returns `null` — never throws for "not found" — so the caller turns that into a `NOT_FOUND`
 * rather than leaking whether a chat exists at all.
 *
 * Build one per request and reuse it: each Super Chat's `related_chats` is fetched once and
 * every parent hop is memoized, so resolving many chats costs O(Super Chats + distinct Helper
 * sessions). A session the engine no longer has (404) has no owner; any other failure throws.
 */
export function createChatOwnershipResolver(
  client: OmnigentClientConfig,
  email: string,
  superChats: OwnedSuperChat[],
): ChatOwnershipResolver {
  // A Helper's parent is its Super Chat or one of its Side Chats, so both count as owners.
  const superIds = new Set(superChats.map((chat) => chat.omnigentSessionId));
  let related: Promise<{
    sideChats: Map<string, { superChat: OwnedSuperChat; chat: OmnigentRelatedChat }>;
    owners: Map<string, OwnedSuperChat>;
  }> | null = null;
  const loadRelated = () => {
    related ??= (async () => {
      const lists = await Promise.all(
        superChats.map(async (superChat) => ({
          superChat,
          chats: (await listOmnigentRelatedChats(client, email, superChat.omnigentSessionId)).data,
        })),
      );
      const owners = new Map(superChats.map((chat) => [chat.omnigentSessionId, chat]));
      const sideChats = new Map<string, { superChat: OwnedSuperChat; chat: OmnigentRelatedChat }>();
      for (const { superChat, chats } of lists) {
        for (const chat of chats) {
          owners.set(chat.id, superChat);
          if (!superIds.has(chat.id)) sideChats.set(chat.id, { superChat, chat });
        }
      }
      return { sideChats, owners };
    })();
    return related;
  };

  const parents = new Map<string, Promise<string | null>>();
  const parentOf = (sessionId: string): Promise<string | null> => {
    let parent = parents.get(sessionId);
    if (!parent) {
      parent = getOmnigentSession(client, email, sessionId).then(
        (session) => session.parent_session_id ?? null,
        (error: unknown) => {
          if (isSessionNotFoundError(error)) return null;
          throw error;
        },
      );
      parents.set(sessionId, parent);
    }
    return parent;
  };

  return async (chatId) => {
    const { sideChats, owners } = await loadRelated();
    const side = sideChats.get(chatId);
    if (side) {
      return {
        kind: "side_chat",
        superSessionId: side.superChat.omnigentSessionId,
        botId: side.superChat.botId,
        live: Boolean(side.chat.live),
      };
    }
    let current: string | null = chatId;
    for (let hop = 0; hop < HELPER_CHAIN_MAX_HOPS && current !== null; hop++) {
      const parentId: string | null = await parentOf(current);
      const owner = parentId ? owners.get(parentId) : undefined;
      if (owner) {
        return { kind: "helper", superSessionId: owner.omnigentSessionId, botId: owner.botId };
      }
      current = parentId;
    }
    return null;
  };
}

/** One-off :func:`createChatOwnershipResolver` lookup, for a single chat per request. */
export function resolveChatOwnership(
  client: OmnigentClientConfig,
  email: string,
  superChats: OwnedSuperChat[],
  chatId: string,
): Promise<ChatOwnership | null> {
  return createChatOwnershipResolver(client, email, superChats)(chatId);
}
