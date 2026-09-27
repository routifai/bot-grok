import type { FollowedTopic, Post, PostKind } from "@aiden/contracts";
import type { PrismaClient } from "./client.js";

// Repository for Post / FollowedTopic (CONTEXT.md "Feed", "Post", "Followed topic";
// docs/muse/PLAN.md B10). Mirrors the pattern in goals.ts / ideas.ts.

interface PostRow {
  id: string;
  kind: string;
  title: string;
  body: string;
  goalId: string | null;
  sourceUrl: string | null;
  artifactId: string | null;
  createdAt: Date;
}

interface FollowedTopicRow {
  id: string;
  topic: string;
  createdAt: Date;
}

export function mapPost(row: PostRow): Post {
  return {
    id: row.id,
    kind: row.kind as PostKind,
    title: row.title,
    body: row.body,
    goalId: row.goalId,
    sourceUrl: row.sourceUrl,
    artifactId: row.artifactId,
    createdAt: row.createdAt.toISOString(),
  };
}

export function mapFollowedTopic(row: FollowedTopicRow): FollowedTopic {
  return { id: row.id, topic: row.topic, createdAt: row.createdAt.toISOString() };
}

export interface PostPage {
  posts: Post[];
  nextCursor: string | null;
}

const POST_CURSOR_PREFIX = "v1.";

/** Opaque `feed.list` cursor: the last-seen Post's (createdAt, id), for a stable
 * strictly-decreasing keyset page boundary even when several Posts share a timestamp
 * (e.g. one `feed.topics` run writing 1-3 Posts at once). */
function encodePostCursor(cursor: { createdAt: Date; id: string }): string {
  return (
    POST_CURSOR_PREFIX +
    Buffer.from(
      JSON.stringify({ createdAt: cursor.createdAt.toISOString(), id: cursor.id }),
      "utf8",
    ).toString("base64url")
  );
}

export class PostCursorError extends Error {
  constructor() {
    super("Invalid feed cursor");
    this.name = "PostCursorError";
  }
}

function decodePostCursor(value: string): { createdAt: Date; id: string } {
  if (!value.startsWith(POST_CURSOR_PREFIX)) throw new PostCursorError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      Buffer.from(value.slice(POST_CURSOR_PREFIX.length), "base64url").toString("utf8"),
    );
  } catch {
    throw new PostCursorError();
  }
  if (typeof parsed !== "object" || parsed === null) throw new PostCursorError();
  const record = parsed as Record<string, unknown>;
  if (typeof record.createdAt !== "string" || typeof record.id !== "string" || !record.id) {
    throw new PostCursorError();
  }
  const createdAt = new Date(record.createdAt);
  if (Number.isNaN(createdAt.getTime())) throw new PostCursorError();
  return { createdAt, id: record.id };
}

const POST_PAGE_SIZE = 30;

export interface PostDraft {
  kind: PostKind;
  title: string;
  body: string;
  goalId?: string | null;
  sourceUrl?: string | null;
  artifactId?: string | null;
}

export function createPostRepos(prisma: PrismaClient) {
  return {
    /** This Muse's Posts, newest first (CONTEXT.md "Feed": "Posts", newest first). */
    async listPosts(botId: string, cursor?: string): Promise<PostPage> {
      const after = cursor ? decodePostCursor(cursor) : null;
      const rows = await prisma.post.findMany({
        where: {
          botId,
          ...(after
            ? {
                OR: [
                  { createdAt: { lt: after.createdAt } },
                  { createdAt: after.createdAt, id: { lt: after.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: POST_PAGE_SIZE + 1,
      });
      const hasMore = rows.length > POST_PAGE_SIZE;
      const page = hasMore ? rows.slice(0, POST_PAGE_SIZE) : rows;
      const last = page.at(-1);
      return {
        posts: page.map(mapPost),
        nextCursor: hasMore && last ? encodePostCursor(last) : null,
      };
    },

    /** Creates a Post (a Goal report or a Followed-topic finding) and returns it mapped. */
    async createPost(
      scope: { spaceId: string; userId: string; botId: string },
      draft: PostDraft,
    ): Promise<Post> {
      const row = await prisma.post.create({
        data: {
          spaceId: scope.spaceId,
          userId: scope.userId,
          botId: scope.botId,
          kind: draft.kind,
          title: draft.title,
          body: draft.body,
          goalId: draft.goalId ?? null,
          sourceUrl: draft.sourceUrl ?? null,
          artifactId: draft.artifactId ?? null,
        },
      });
      return mapPost(row);
    },
  };
}

export function createTopicRepos(prisma: PrismaClient) {
  return {
    /** A Muse's Followed topics, oldest first (the order they were added in). */
    async listTopics(botId: string): Promise<FollowedTopic[]> {
      const rows = await prisma.followedTopic.findMany({
        where: { botId },
        orderBy: { createdAt: "asc" },
      });
      return rows.map(mapFollowedTopic);
    },

    /** One Followed topic, or null. Used to authorize a remove by the topic's own bot. */
    async getTopic(topicId: string): Promise<(FollowedTopic & { botId: string }) | null> {
      const row = await prisma.followedTopic.findUnique({ where: { id: topicId } });
      return row ? { ...mapFollowedTopic(row), botId: row.botId } : null;
    },

    /**
     * Follows a topic, idempotently (unique on `[botId, topic]`): following an
     * already-followed topic just returns the existing row rather than erroring.
     */
    async followTopic(
      scope: { spaceId: string; userId: string; botId: string },
      topic: string,
    ): Promise<FollowedTopic> {
      const row = await prisma.followedTopic.upsert({
        where: { botId_topic: { botId: scope.botId, topic } },
        create: { spaceId: scope.spaceId, userId: scope.userId, botId: scope.botId, topic },
        update: {},
      });
      return mapFollowedTopic(row);
    },

    /** Unfollows a topic by id. A no-op (not an error) if it's already gone. */
    async removeTopic(topicId: string): Promise<void> {
      await prisma.followedTopic.deleteMany({ where: { id: topicId } });
    },

    /** Unfollows a topic by its exact text, for the conversational `unfollow_topic` tool. */
    async removeTopicByName(botId: string, topic: string): Promise<boolean> {
      const result = await prisma.followedTopic.deleteMany({ where: { botId, topic } });
      return result.count > 0;
    },
  };
}
