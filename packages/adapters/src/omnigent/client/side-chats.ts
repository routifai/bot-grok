import { redactSecrets } from "@aiden/core";
import type { OmnigentClientConfig } from "./core.js";
import { errorCodeFromBody, omnigentHeaders, throwOnError } from "./core.js";
import type { OmnigentPaginatedList } from "./sessions.js";

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
