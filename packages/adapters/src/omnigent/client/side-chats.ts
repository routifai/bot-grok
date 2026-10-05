import { redactSecrets } from "@aiden/core";
import type { OmnigentClientConfig } from "./core.js";
import { omnigentHeaders, throwOnError } from "./core.js";
import type { OmnigentPaginatedList } from "./sessions.js";

export interface OmnigentSideChatCreateResponse {
  conversation_id: string;
  title: string | null;
  start: "with_context" | "blank";
  /** Set by the engine (docs/super-chat/WIRING.md slice A1 review) when the Side Chat itself
   * was created but its seed first message could not be posted — the chat still exists;
   * `apps/api/src/chats.ts#createSideChat` retries the post once. */
  first_message_error?: string | null;
}

/** Thrown by `createOmnigentSideChat` on a non-2xx response. `conversationId` is set when the
 * (redacted-before-reaching-here) error body still names a `conversation_id` — i.e. the Side
 * Chat was created despite the error — so the caller can tell "nothing happened" apart from
 * "it exists, but something about it (its first message) failed". */
export class OmnigentSideChatError extends Error {
  conversationId: string | null;
  constructor(message: string, conversationId: string | null) {
    super(message);
    this.name = "OmnigentSideChatError";
    this.conversationId = conversationId;
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
 * Side Chat of the Super Chat `superId`, optionally seeded with its first message. Diverges
 * from the generic `throwOnError` path on a non-2xx response (see `OmnigentSideChatError`)
 * because a Side Chat can exist even when this call reports an error. */
export async function createOmnigentSideChat(
  config: OmnigentClientConfig,
  email: string,
  superSessionId: string,
  input: { start: "with_context" | "blank"; title?: string; firstMessage?: string },
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
