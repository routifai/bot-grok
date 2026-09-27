// Handlers for the Feed's conversational tools (CONTEXT.md "Followed topic", "Post";
// docs/muse/PLAN.md B10). Pattern: goal-tools.ts. Each `*FromTool` function is called
// directly from the executor's tool dispatch with plain input already coerced from the
// model's tool-call args.
//
// `follow_topic` / `unfollow_topic` let the Muse act on "follow AI in banking news" /
// "stop following X" said in conversation. `feed_add_topic_post` is how the
// `feed.topics` background digest (feed-jobs.ts) actually writes a Post: a structured
// tool call is more robust than parsing the run's free-text reply for findings.
import type { JobPublisher } from "@aiden/adapter-kit";
import type { Post } from "@aiden/contracts";
import { createPostRepos, createTopicRepos, type PrismaClient } from "@aiden/db";
import { scheduleFeedDigestOnFirstTopic } from "./feed-jobs.js";

const TOPIC_MAX = 200;
const POST_TITLE_MAX = 200;
const POST_BODY_MAX = 2_000;

export type FeedToolDeps = {
  prisma: PrismaClient;
  /** Schedules the Muse's first `feed.topics` firing (docs/muse/PLAN.md B10) — optional
   * so callers/tests that only exercise the follow/unfollow logic keep working without a
   * job queue at hand (mirrors GoalToolDeps.jobs). */
  jobs?: JobPublisher;
};

export type FeedToolScope = { spaceId: string; botId: string; userId: string };

function cleanTopic(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, TOPIC_MAX) : "";
}

/** `follow_topic`: the person asked the Muse to keep an eye on something ("follow AI in banking news"). */
export async function followTopicFromTool(
  deps: FeedToolDeps,
  scope: FeedToolScope,
  input: { topic: string },
): Promise<{ topic: { id: string; topic: string } } | { error: string }> {
  const topic = cleanTopic(input.topic);
  if (!topic) return { error: "topic is required." };
  const topics = createTopicRepos(deps.prisma);
  const followed = await topics.followTopic(scope, topic);
  if (deps.jobs) {
    const count = (await topics.listTopics(scope.botId)).length;
    await scheduleFeedDigestOnFirstTopic(
      { prisma: deps.prisma, jobs: deps.jobs },
      scope.botId,
      count,
    );
  }
  return { topic: followed };
}

/** `unfollow_topic`: the person asked the Muse to stop following something. */
export async function unfollowTopicFromTool(
  deps: FeedToolDeps,
  scope: Pick<FeedToolScope, "botId">,
  input: { topic: string },
): Promise<{ ok: true } | { error: string }> {
  const topic = cleanTopic(input.topic);
  if (!topic) return { error: "topic is required." };
  const removed = await createTopicRepos(deps.prisma).removeTopicByName(scope.botId, topic);
  if (!removed) return { error: `Not following "${topic}".` };
  return { ok: true as const };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * `feed_add_topic_post`: called during a `feed.topics` research turn (feed-jobs.ts) once
 * per finding worth telling the person about. Always a `topic` Post with a real source.
 */
export async function addTopicPostFromTool(
  deps: FeedToolDeps,
  scope: FeedToolScope,
  input: { title: string; body: string; sourceUrl: string },
): Promise<{ post: Post } | { error: string }> {
  const title = (input.title ?? "").trim().slice(0, POST_TITLE_MAX);
  if (!title) return { error: "title is required." };
  const body = (input.body ?? "").trim().slice(0, POST_BODY_MAX);
  if (!body) return { error: "body is required." };
  const sourceUrl = (input.sourceUrl ?? "").trim();
  if (!isHttpUrl(sourceUrl)) return { error: "sourceUrl must be a valid http(s) URL." };

  const post = await createPostRepos(deps.prisma).createPost(scope, {
    kind: "topic",
    title,
    body,
    sourceUrl,
  });
  return { post };
}
