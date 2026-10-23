import type { OmnigentClientConfig } from "./client/core.js";
import { omnigentHeaders, throwOnError } from "./client/core.js";

/** A topic as the engine serves it (`superchat/topics/routes.py` `topic_to_response`). */
export interface OmnigentTopic {
  key: string;
  title: string;
  left_off: string;
  covered: { date: string; kind: string; text: string; file?: string }[];
  open: { kind: string; text: string }[];
  starters: string[];
  events: { at: number; line: string }[];
  sources: { chats?: number; files?: number; emails?: number };
  status: string;
  since: string | null;
  since_at: number | null;
  last_touched_at: number;
}

/** `GET /v1/me/topics?days=` — the person's open topics touched within `days`, newest first. */
export async function listOmnigentTopics(
  config: OmnigentClientConfig,
  email: string,
  days = 7,
): Promise<OmnigentTopic[]> {
  const url = new URL("/v1/me/topics", config.baseUrl);
  url.searchParams.set("days", String(days));
  const response = await fetch(url, { headers: omnigentHeaders(config, email) });
  await throwOnError(response, "list topics", config.secrets);
  const body = (await response.json()) as { topics?: OmnigentTopic[] };
  return body.topics ?? [];
}

/** `POST /v1/me/topics/{key}/pick` — add the topic's card to the Conversation (no turn starts). */
export async function pickOmnigentTopic(
  config: OmnigentClientConfig,
  email: string,
  key: string,
  conversationId: string,
): Promise<void> {
  const response = await fetch(
    new URL(`/v1/me/topics/${encodeURIComponent(key)}/pick`, config.baseUrl),
    {
      method: "POST",
      headers: omnigentHeaders(config, email),
      body: JSON.stringify({ conversation_id: conversationId }),
    },
  );
  await throwOnError(response, "pick up topic", config.secrets);
}
