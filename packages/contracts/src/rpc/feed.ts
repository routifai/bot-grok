import { oc } from "@orpc/contract";
import * as z from "zod";
import { Id } from "../ids.js";

export const PostKindSchema = z.enum(["goal_report", "topic"]);
export type PostKind = z.infer<typeof PostKindSchema>;

/** One Feed item. Links back to its Goal log, its web source, or a Library artifact. */
export const PostSchema = z.object({
  id: Id,
  kind: PostKindSchema,
  title: z.string(),
  body: z.string(),
  goalId: Id.nullable(),
  sourceUrl: z.string().url().nullable(),
  /** Optional link to a Library artifact this Post is about. */
  artifactId: Id.nullable().optional(),
  createdAt: z.string(),
});
export type Post = z.infer<typeof PostSchema>;

export const FeedSchema = z.object({
  posts: z.array(PostSchema),
  nextCursor: z.string().nullable(),
});
export type Feed = z.infer<typeof FeedSchema>;

export const FollowedTopicSchema = z.object({
  id: Id,
  topic: z.string(),
  createdAt: z.string(),
  /** How often the topic is checked; absent means daily. */
  cadence: z.enum(["hourly", "daily", "weekly"]).optional(),
});
export type FollowedTopic = z.infer<typeof FollowedTopicSchema>;

export const feedContract = {
  feed: {
    list: oc.input(z.object({ botId: Id, cursor: z.string().optional() })).output(FeedSchema),
  },
  topics: {
    list: oc.input(z.object({ botId: Id })).output(z.array(FollowedTopicSchema)),
    follow: oc
      .input(z.object({ botId: Id, topic: z.string().min(1).max(200) }))
      .output(FollowedTopicSchema),
    remove: oc.input(z.object({ topicId: Id })).output(z.object({ ok: z.literal(true) })),
  },
};
