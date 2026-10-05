// Super Chat Side Chats and Helpers (CONTEXT.md "Side Chat", "Helper"; docs/super-chat/
// WIRING.md "chats.*"): mapping between Omnigent's related_chats/side_chats/items shapes and
// Nova's ChatSummary/ThreadMessagePage contracts, plus the ownership rule that lets apps/api
// resolve a bare chatId to the Super Chat (bot) it belongs to before ever trusting it. Every
// Omnigent call is injected through ./client.js's typed functions, so ./chats.test.ts mocks
// fetch the same way ./gateway.test.ts does — no network, no database.
import type { ChatSummary, SideChatStart, ThreadMessage } from "@aiden/contracts";
import { ENGINE_ERROR_NOTE, isEngineErrorText } from "@aiden/core";
import { cardFromToolCall, toolOutputsByCallId } from "./cards.js";
import { isSessionNotFoundError } from "./client/core.js";
import {
  getOmnigentSession,
  listOmnigentRelatedChats,
  type OmnigentClientConfig,
  type OmnigentRelatedChat,
  type OmnigentSessionItem,
  type OmnigentSideChatCreateResponse,
} from "./client.js";
import { type HelperBlock, helperBlockFromToolCall, isStartHelperCall } from "./helpers.js";

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

/** A message item's text, from either a user turn's `input_text` content parts or an
 * assistant turn's `output_text` ones (OpenAI Responses-style content, `to_api_dict` in
 * engine/omnigent/omnigent/entities/conversation.py). Unlike ./gateway.ts's
 * `extractAssistantText` (assistant-only, `output_text`-only — all it ever needs for a turn's
 * reply), this reads either role, since `chats.messages` renders a whole conversation. */
function extractItemText(item: OmnigentSessionItem): string {
  const content = Array.isArray(item.content) ? item.content : [];
  const parts: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      ((block as { type?: unknown }).type === "output_text" ||
        (block as { type?: unknown }).type === "input_text") &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join("\n\n").trim();
}

/** A message the engine wrote itself (a Helper's wake notice, a timer firing) is plumbing with
 * internal names in it: never shown. The Muse's reply to it follows in the chat. The engine
 * flags these; the `[System` text prefix is only the fallback for items stored before it did. */
export function isSystemNotice(item: OmnigentSessionItem, text: string): boolean {
  return item.is_system_notice === true || text.startsWith("[System");
}

/** `message` items (user/assistant) from `GET .../items` -> `ThreadMessage[]`, in the same
 * (ascending) order given. A `render_card` call becomes a bot message holding its reply card
 * (pending until its output arrives); a `start_helper` call becomes a Helper row that follows the
 * next assistant message (the hand-off), never a message of its own. Other tool-call items (`function_call`/
 * `function_call_output`, etc.) and anything else that isn't a plain text turn are skipped — `chats.messages` renders a chat
 * transcript, not an Activity's Steps (that's `activities.get`). `seq` is synthesized from
 * position: Omnigent items aren't Nova's own thread rows, so there is no durable sequence
 * number to carry over. */
export function mapOmnigentItemsToMessages(
  chatId: string,
  items: OmnigentSessionItem[],
): ThreadMessage[] {
  const messages: ThreadMessage[] = [];
  const outputs = toolOutputsByCallId(items);
  let helpersStarted: HelperBlock[] = [];
  for (const item of items) {
    if (item.type === "function_call") {
      if (isStartHelperCall(item)) {
        const helper = helperBlockFromToolCall(outputs.get(String(item.call_id ?? "")));
        if (helper) helpersStarted.push(helper);
        continue;
      }
      const card = cardFromToolCall(item, outputs);
      if (card) {
        messages.push({
          id: item.id,
          threadId: chatId,
          seq: messages.length,
          role: "bot",
          blocks: [card],
          createdAt: epochSecondsToIso(item.created_at),
        });
      }
      continue;
    }
    if (item.type !== "message") continue;
    const role = item.role === "assistant" ? "bot" : item.role === "user" ? "user" : null;
    if (!role) continue;
    const raw = extractItemText(item);
    if (!raw) continue;
    if (role === "user" && isSystemNotice(item, raw)) continue;
    // A raw engine/model failure is never shown: it reads as a calm system note.
    const notice = role === "bot" && isEngineErrorText(raw) ? ENGINE_ERROR_NOTE : null;
    const text = notice ?? raw;
    const handOff = role === "bot" && !notice ? helpersStarted : [];
    if (handOff.length > 0) helpersStarted = [];
    messages.push({
      id: item.id,
      threadId: chatId,
      seq: messages.length,
      role: notice ? "system" : role,
      blocks: [{ kind: "text", text }, ...handOff],
      createdAt: epochSecondsToIso(item.created_at),
    });
  }
  return messages;
}

export type ChatOwnershipKind = "side_chat" | "helper";

export interface ChatOwnership {
  kind: ChatOwnershipKind;
  /** The caller's Super Chat `chatId` resolves under. */
  superSessionId: string;
  botId: string;
  /** For a with-context side chat: its seed checkpoint; earlier items are the copied parent. */
  seedItemId?: string | null;
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
        seedItemId: side.chat.seed_item_id ?? null,
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
