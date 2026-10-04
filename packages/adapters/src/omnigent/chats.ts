// Super Chat Side Chats and Helpers (CONTEXT.md "Side Chat", "Helper"; docs/super-chat/
// WIRING.md "chats.*"): mapping between Omnigent's related_chats/side_chats/items shapes and
// Nova's ChatSummary/ThreadMessagePage contracts, plus the ownership rule that lets apps/api
// resolve a bare chatId to the Super Chat (bot) it belongs to before ever trusting it. Every
// Omnigent call is injected through ./client.js's typed functions, so ./chats.test.ts mocks
// fetch the same way ./gateway.test.ts does — no network, no database.
import type { ChatSummary, SideChatStart, ThreadMessage } from "@aiden/contracts";
import { ENGINE_ERROR_NOTE, isEngineErrorText } from "@aiden/core";
import { isRenderCardCall, replyCardFromToolCall, toolOutputsByCallId } from "./cards.js";
import {
  getOmnigentSession,
  listOmnigentRelatedChats,
  type OmnigentClientConfig,
  type OmnigentRelatedChat,
  type OmnigentSessionItem,
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
    summary: raw.summary ?? null,
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

/** `message` items (user/assistant) from `GET .../items` -> `ThreadMessage[]`, in the same
 * (ascending) order given. A `render_card` call becomes a bot message holding its reply card
 * (pending until its output arrives). Other tool-call items (`function_call`/
 * `function_call_output`, etc.) and anything else that isn't a plain text turn are skipped — `chats.messages` renders a chat
 * transcript, not an Activity's Steps (that's `activities.get`). `seq` is synthesized from
 * position: Omnigent items aren't Nova's own thread rows, so there is no durable sequence
 * number to carry over. */
const WAKE_NOTICE = /^\[System: sub-agent (\S+?)\/(.+?) finished \((\w+)\)/;

/** The engine's wake notice to a chat ("[System: sub-agent researcher/title finished (completed)
 * — …]") is plumbing; show it as one plain system line instead of a message from the person. */
export function systemNoticeText(text: string): string | null {
  if (!text.startsWith("[System:")) return null;
  const match = WAKE_NOTICE.exec(text);
  if (!match) return "Nova received an update.";
  const [, agent, title, status] = match;
  const who = agent?.startsWith("__web") ? "Web research" : `“${title}”`;
  return status === "completed"
    ? `${who} finished.`
    : `${who} ${status === "failed" ? "failed" : "stopped"}.`;
}

export function mapOmnigentItemsToMessages(
  chatId: string,
  items: OmnigentSessionItem[],
): ThreadMessage[] {
  const messages: ThreadMessage[] = [];
  const outputs = toolOutputsByCallId(items);
  for (const item of items) {
    if (isRenderCardCall(item)) {
      const callId = typeof item.call_id === "string" ? item.call_id : "";
      const card = replyCardFromToolCall(item, outputs.get(callId));
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
    // A raw engine/model failure is never shown: it reads as a calm system note.
    const notice =
      role === "user" ? systemNoticeText(raw) : isEngineErrorText(raw) ? ENGINE_ERROR_NOTE : null;
    const text = notice ?? raw;
    messages.push({
      id: item.id,
      threadId: chatId,
      seq: messages.length,
      role: notice ? "system" : role,
      blocks: [{ kind: "text", text }],
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

/**
 * The ownership rule (docs/super-chat/WIRING.md "Identity and ownership"): `chatId` must be a
 * Side Chat of one of the caller's own Super Chats (`related_chats`), or a Helper whose
 * `parent_session_id` chain reaches one within `HELPER_CHAIN_MAX_HOPS` hops. Returns `null` —
 * never throws for "not found" — so the caller (apps/api/src/chats.ts) turns that into a
 * `NOT_FOUND` rather than leaking whether a chat exists at all.
 */
export async function resolveChatOwnership(
  client: OmnigentClientConfig,
  email: string,
  superChats: OwnedSuperChat[],
  chatId: string,
): Promise<ChatOwnership | null> {
  // A Helper's parent is its Super Chat or one of its Side Chats, so both count as owners.
  const bySessionId = new Map(superChats.map((chat) => [chat.omnigentSessionId, chat]));
  for (const superChat of superChats) {
    if (superChat.omnigentSessionId === chatId) continue; // the Super Chat itself isn't a "chat"
    const related = await listOmnigentRelatedChats(client, email, superChat.omnigentSessionId);
    const sideChat = related.data.find((chat) => chat.id === chatId);
    if (sideChat) {
      return {
        kind: "side_chat",
        superSessionId: superChat.omnigentSessionId,
        botId: superChat.botId,
        seedItemId: sideChat.seed_item_id ?? null,
        live: Boolean(sideChat.live),
      };
    }
    for (const chat of related.data) bySessionId.set(chat.id, superChat);
  }

  let current: string | null = chatId;
  for (let hop = 0; hop < HELPER_CHAIN_MAX_HOPS && current !== null; hop++) {
    const parentId: string | null = await fetchParentSessionId(client, email, current);
    if (parentId) {
      const owner = bySessionId.get(parentId);
      if (owner) {
        return { kind: "helper", superSessionId: owner.omnigentSessionId, botId: owner.botId };
      }
    }
    current = parentId;
  }
  return null;
}

async function fetchParentSessionId(
  client: OmnigentClientConfig,
  email: string,
  sessionId: string,
): Promise<string | null> {
  try {
    const snapshot = await getOmnigentSession(client, email, sessionId);
    return snapshot.parent_session_id ?? null;
  } catch {
    return null;
  }
}
