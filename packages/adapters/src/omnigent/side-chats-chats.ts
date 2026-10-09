// Super Chat Side Chats and Helpers (CONTEXT.md "Side Chat", "Helper"; docs/super-chat/
// WIRING.md "chats.*"): mapping between Omnigent's related_chats/side_chats shapes and
// Nova's ChatSummary contract (the transcript is ./transcript.ts), plus the ownership rule that lets apps/api
// resolve a bare chatId to the Super Chat (bot) it belongs to before ever trusting it. Every
// Omnigent call is injected through ./client.js's typed functions, so ./chats.test.ts mocks
// fetch the same way ./gateway.test.ts does — no network, no database.
import type { ChatSummary, SideChatStart } from "@nova/contracts";
import { isSessionNotFoundError } from "./client/core.js";
import {
  getOmnigentSession,
  type OmnigentClientConfig,
  type OmnigentRelatedChat,
  type OmnigentSideChatCreateResponse,
} from "./client.js";

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
    unread: Boolean(raw.unread),
    anchorItemId: raw.anchor_item_id ?? null,
    forkCount: raw.fork_count ?? 0,
    forkState: raw.fork_state ?? null,
    forkSummary: raw.fork_summary ?? null,
    forkParentId: raw.fork_parent_id ?? null,
    anchorSnippet: raw.anchor_snippet ?? null,
    replies: raw.replies ?? null,
    project: raw.project ?? null,
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
    unread: false,
    ...(created.first_message_error_code || created.first_message_error
      ? { firstMessageErrorCode: created.first_message_error_code ?? "unknown" }
      : {}),
    anchorItemId: created.anchor_item_id ?? null,
    forkCount: 0,
    updatedAt: new Date().toISOString(),
  };
}

export type ChatOwnershipKind = "side_chat" | "helper";

export interface ChatOwnership {
  kind: ChatOwnershipKind;
  /** The caller's Super Chat `chatId` resolves under. */
  superSessionId: string;
  botId: string;
  /** The Project the chat has open (ADR 0008). */
  project: { slug: string; name: string } | null;
}

export interface OwnedSuperChat {
  botId: string;
  omnigentSessionId: string;
}

export type ChatOwnershipResolver = (chatId: string) => Promise<ChatOwnership | null>;

/**
 * The ownership rule (ADR 0009): `chatId` is a Side Chat or Helper whose family root, as the
 * engine reports it on the session (`superchat.root_id`), is one of the caller's own Super Chats.
 * The engine itself answers 404 for a session the caller cannot read. Returns `null`, never
 * throws, for "not yours", so the caller turns that into a `NOT_FOUND` rather than leaking
 * whether a chat exists; any other failure throws.
 *
 * Build one per request and reuse it: each chat's session is read once.
 */
export function createChatOwnershipResolver(
  client: OmnigentClientConfig,
  email: string,
  superChats: OwnedSuperChat[],
): ChatOwnershipResolver {
  const owners = new Map(superChats.map((chat) => [chat.omnigentSessionId, chat]));
  const resolved = new Map<string, Promise<ChatOwnership | null>>();
  const resolve = async (chatId: string): Promise<ChatOwnership | null> => {
    const session = await getOmnigentSession(client, email, chatId).catch((error: unknown) => {
      if (isSessionNotFoundError(error)) return null;
      throw error;
    });
    const family = session?.superchat;
    if (!family?.root_id || (family.kind !== "side" && family.kind !== "helper")) return null;
    const owner = owners.get(family.root_id);
    if (!owner) return null;
    return {
      kind: family.kind === "side" ? "side_chat" : "helper",
      superSessionId: owner.omnigentSessionId,
      botId: owner.botId,
      project: family.project ?? null,
    };
  };
  return (chatId) => {
    let found = resolved.get(chatId);
    if (!found) {
      found = resolve(chatId);
      resolved.set(chatId, found);
    }
    return found;
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
