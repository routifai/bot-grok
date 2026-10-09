import type { OmnigentClientConfig } from "./client/core.js";
import { omnigentHeaders, throwOnError } from "./client/core.js";

/** A topic the Muse follows for the person (`GET /v1/me/topics`). */
export interface OmnigentTopic {
  id: string;
  name: string;
  cadence: "hourly" | "daily" | "weekly" | null;
  rrule: string;
  timezone: string | null;
  state: string;
  /** The Super Chat the topic runs under. */
  session_id: string | null;
  /** Epoch seconds. */
  created_at: number | null;
}

/** One finished topic run (`GET /v1/me/feed`). */
export interface OmnigentFeedPost {
  id: string;
  topic_id: string;
  run_id: string;
  session_id: string;
  /** Epoch seconds. */
  created_at: number;
  text: string;
  cards: unknown[];
  nothing_new: boolean;
}

export interface OmnigentFeedPage {
  data: OmnigentFeedPost[];
  has_more: boolean;
  next_cursor: string | null;
}

/** `GET /v1/me/topics` — the caller's followed topics, oldest first. */
export async function listOmnigentTopics(
  config: OmnigentClientConfig,
  email: string,
): Promise<OmnigentTopic[]> {
  const response = await fetch(new URL("/v1/me/topics", config.baseUrl), {
    headers: omnigentHeaders(config, email),
  });
  await throwOnError(response, "list topics", config.secrets);
  return ((await response.json()) as { data: OmnigentTopic[] }).data;
}

/** `GET /v1/me/feed` — posts from the caller's followed topics, newest first; runs that found
 * nothing new are left out. `before` is the previous page's `next_cursor`. */
export async function listOmnigentFeed(
  config: OmnigentClientConfig,
  email: string,
  query: { limit?: number; before?: string; topicId?: string } = {},
): Promise<OmnigentFeedPage> {
  const url = new URL("/v1/me/feed", config.baseUrl);
  if (query.limit) url.searchParams.set("limit", String(query.limit));
  if (query.before) url.searchParams.set("before", query.before);
  if (query.topicId) url.searchParams.set("topic_id", query.topicId);
  const response = await fetch(url, { headers: omnigentHeaders(config, email) });
  await throwOnError(response, "list feed", config.secrets);
  return (await response.json()) as OmnigentFeedPage;
}
