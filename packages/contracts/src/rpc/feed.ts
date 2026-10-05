import { oc } from "@orpc/contract";
import * as z from "zod";
import { Id } from "../ids.js";
import { FeedSchema, FollowedTopicSchema, IdeaSchema, MuseSettingsSchema } from "../muse.js";

export const feedContract = {
  feed: {
    list: oc.input(z.object({ botId: Id, cursor: z.string().optional() })).output(FeedSchema),
  },
  ideas: {
    list: oc.input(z.object({ botId: Id })).output(z.array(IdeaSchema)),
    refresh: oc.input(z.object({ botId: Id })).output(z.array(IdeaSchema)),
    /** "Do it": the Idea's message is sent into the Conversation as the person's own. */
    accept: oc.input(z.object({ botId: Id, ideaId: Id })).output(z.object({ ok: z.literal(true) })),
    dismiss: oc
      .input(z.object({ botId: Id, ideaId: Id }))
      .output(z.object({ ok: z.literal(true) })),
  },
  topics: {
    list: oc.input(z.object({ botId: Id })).output(z.array(FollowedTopicSchema)),
    follow: oc
      .input(z.object({ botId: Id, topic: z.string().min(1).max(200) }))
      .output(FollowedTopicSchema),
    remove: oc.input(z.object({ topicId: Id })).output(z.object({ ok: z.literal(true) })),
  },
  muse: {
    settings: oc.input(z.object({ botId: Id })).output(MuseSettingsSchema),
    updateSettings: oc
      .input(MuseSettingsSchema.partial().safeExtend({ botId: Id }))
      .output(MuseSettingsSchema),
  },
  // The Activity panel (CONTEXT.md "Activity", "Activity Feed"; docs/super-chat/README.md):
  // everything the Muse did, newest first, by day. Scoped to the bot's Super Chat family (the
  // Conversation, its Side Chats, and their Helpers).
};
