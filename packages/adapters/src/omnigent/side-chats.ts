import type { ChatSummary, SideChatStart } from "@nova/contracts";
import { redactSecrets } from "@nova/core";
import type { OmnigentClientConfig } from "./client/core.js";
import {
  errorCodeFromBody,
  isSessionNotFoundError,
  omnigentHeaders,
  throwOnError,
} from "./client/core.js";
import { getOmnigentSession, type OmnigentPaginatedList } from "./client/sessions.js";

export interface OmnigentSideChatCreateResponse {
  conversation_id: string;
  title: string | null;
  start: "with_context" | "blank";
  /** Set by the engine when the Side Chat itself was created but its first message could not
   * be delivered, after the engine's own retry; the chat exists and the person resends in it. */
  first_message_error?: string | null;
  /** The failure's code (e.g. `runner_unavailable`, `transport_error`). */
  first_message_error_code?: string | null;
  /** A Fork (ADR 0010): the message it started from, and the chat holding it. */
  anchor_item_id?: string | null;
  parent_id?: string | null;
}

/** Thrown by `createOmnigentSideChat` on a non-2xx response. `conversationId` is set when the
 * (redacted-before-reaching-here) error body still names a `conversation_id` — i.e. the Side
 * Chat was created despite the error — so the caller can tell "nothing happened" apart from
 * "it exists, but something about it (its first message) failed". */
export class OmnigentSideChatError extends Error {
  conversationId: string | null;
  /** The engine's error code (e.g. `fork_too_deep`, `fork_anchor_invalid`). */
  code: string | undefined;
  constructor(message: string, conversationId: string | null, code?: string) {
    super(message);
    this.name = "OmnigentSideChatError";
    this.conversationId = conversationId;
    this.code = code;
  }
}

function conversationIdFromBody(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { conversation_id?: unknown };
    return typeof parsed.conversation_id === "string" ? parsed.conversation_id : null;
  } catch {
    return null;
  }
}

/** `POST /v1/sessions/{superId}/side_chats` (docs/super-chat/WIRING.md slice E1): creates a
 * Side Chat of the Super Chat `superId`, optionally seeded with its first message. With
 * `anchorItemId` it opens a Fork (ADR 0010) and `superSessionId` is the chat holding that
 * message (the Super Chat, or a fork of it). Diverges
 * from the generic `throwOnError` path on a non-2xx response (see `OmnigentSideChatError`)
 * because a Side Chat can exist even when this call reports an error. */
export async function createOmnigentSideChat(
  config: OmnigentClientConfig,
  email: string,
  superSessionId: string,
  input: {
    start: "with_context" | "blank";
    title?: string;
    firstMessage?: string;
    anchorItemId?: string;
  },
): Promise<OmnigentSideChatCreateResponse> {
  const response = await fetch(
    new URL(`/v1/sessions/${encodeURIComponent(superSessionId)}/side_chats`, config.baseUrl),
    {
      method: "POST",
      headers: omnigentHeaders(config, email),
      body: JSON.stringify({
        start: input.start,
        ...(input.title ? { title: input.title } : {}),
        ...(input.firstMessage ? { first_message: input.firstMessage } : {}),
        ...(input.anchorItemId ? { anchor_item_id: input.anchorItemId } : {}),
      }),
    },
  );
  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    const conversationId = conversationIdFromBody(raw);
    const body = config.secrets ? redactSecrets(raw, config.secrets).slice(0, 500) : "";
    throw new OmnigentSideChatError(
      `omnigent create side chat failed (${response.status}): ${body}`,
      conversationId,
      errorCodeFromBody(raw),
    );
  }
  return (await response.json()) as OmnigentSideChatCreateResponse;
}

export interface OmnigentRelatedChat {
  id: string;
  title: string | null;
  created_at: number;
  updated_at: number;
  last_message_preview: string | null;
  archived?: boolean;
  start?: "with_context" | "blank" | null;
  summary?: string | null;
  /** `summary` as the person reads it: the engine has already dropped its model-facing framing. */
  summary_body?: string | null;
  /** First item that belongs to a with-context side chat itself (its seed checkpoint). */
  seed_item_id?: string | null;
  live?: boolean;
  /** The caller's read state: a reply landed that they have not seen. */
  unread?: boolean;
  last_read_at?: number | null;
  /** A Fork's anchor (ADR 0010); `null` for a plain Side Chat. */
  anchor_item_id?: string | null;
  /** How many forks hang off this chat's messages. */
  fork_count?: number;
  /** Forks only (null otherwise): state, added summary, the chat holding the anchor, the
   * anchor's text (≤120 characters) and the reply count. */
  fork_state?: "open" | "added" | "archived" | null;
  fork_summary?: string | null;
  fork_parent_id?: string | null;
  anchor_snippet?: string | null;
  replies?: number | null;
  /** The Project the chat has open (ADR 0008). */
  project?: { slug: string; name: string } | null;
}

/** `GET /v1/sessions/{superId}/related_chats` — the Super Chat's Side Chats (not cursor-
 * paginated; superside-chat.md). */
export async function listOmnigentRelatedChats(
  config: OmnigentClientConfig,
  email: string,
  superSessionId: string,
): Promise<OmnigentPaginatedList<OmnigentRelatedChat>> {
  const response = await fetch(
    new URL(`/v1/sessions/${encodeURIComponent(superSessionId)}/related_chats`, config.baseUrl),
    { headers: omnigentHeaders(config, email) },
  );
  await throwOnError(response, "list related chats", config.secrets);
  return (await response.json()) as OmnigentPaginatedList<OmnigentRelatedChat>;
}

/** `GET /v1/sessions/{id}/context_summary` — the summary a new "Knows our conversation" Side
 * Chat would start with. */
export async function getOmnigentContextSummary(
  config: OmnigentClientConfig,
  email: string,
  sessionId: string,
): Promise<{ summary: string | null; summary_body: string | null; created_at: number | null }> {
  const response = await fetch(
    new URL(`/v1/sessions/${encodeURIComponent(sessionId)}/context_summary`, config.baseUrl),
    { headers: omnigentHeaders(config, email) },
  );
  await throwOnError(response, "get context summary", config.secrets);
  return (await response.json()) as {
    summary: string | null;
    summary_body: string | null;
    created_at: number | null;
  };
}

/** `POST /v1/sessions/{forkId}/add_to_conversation` — adds a Fork's one-line summary back under
 * its anchor (ADR 0010); the engine writes the summary when none is given. */
export async function addOmnigentForkToConversation(
  config: OmnigentClientConfig,
  email: string,
  forkId: string,
  summary?: string,
): Promise<{
  fork_id: string;
  session_id: string;
  anchor_item_id: string | null;
  item_id: string | null;
  title: string | null;
  summary: string;
  state: "added" | "archived";
}> {
  const response = await fetch(
    new URL(`/v1/sessions/${encodeURIComponent(forkId)}/add_to_conversation`, config.baseUrl),
    {
      method: "POST",
      headers: omnigentHeaders(config, email),
      body: JSON.stringify(summary ? { summary } : {}),
    },
  );
  await throwOnError(response, "add fork to conversation", config.secrets);
  return (await response.json()) as {
    fork_id: string;
    session_id: string;
    anchor_item_id: string | null;
    item_id: string | null;
    title: string | null;
    summary: string;
    state: "added" | "archived";
  };
}

/** `PATCH /v1/sessions/{id}` with `archived` — the Side Chat archive (CONTEXT.md "Archived"). */
export async function archiveOmnigentSession(
  config: OmnigentClientConfig,
  email: string,
  sessionId: string,
): Promise<void> {
  await setOmnigentSessionArchived(config, email, sessionId, true);
}

/** `PATCH /v1/sessions/{id}` with `archived: false` — restores an archived Side Chat or Fork, so
 * it is writable and listed with the open ones again. */
export async function unarchiveOmnigentSession(
  config: OmnigentClientConfig,
  email: string,
  sessionId: string,
): Promise<void> {
  await setOmnigentSessionArchived(config, email, sessionId, false);
}

async function setOmnigentSessionArchived(
  config: OmnigentClientConfig,
  email: string,
  sessionId: string,
  archived: boolean,
): Promise<void> {
  const response = await fetch(
    new URL(`/v1/sessions/${encodeURIComponent(sessionId)}`, config.baseUrl),
    {
      method: "PATCH",
      headers: omnigentHeaders(config, email),
      body: JSON.stringify({ archived }),
    },
  );
  await throwOnError(response, archived ? "archive session" : "unarchive session", config.secrets);
}

// Mapping between Omnigent's related_chats/side_chats shapes and Nova's ChatSummary contract (the
// transcript is ./transcript.ts), plus the ownership rule that lets apps/api resolve a bare chatId
// to the Super Chat (bot) it belongs to before ever trusting it (docs/super-chat/WIRING.md "chats.*").

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
