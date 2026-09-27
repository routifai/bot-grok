// `feed.topics`'s task prompt (CONTEXT.md "Followed topic"; docs/muse/PLAN.md B10).
// Adapted from OpenMuse (MIT) — openmuse/server/service.py's feed-posts behaviour,
// rewritten for Aiden's `feed_add_topic_post` tool and its own web_search/web_fetch tools
// rather than OpenMuse's feed-writing helper.
import type { FollowedTopic } from "@aiden/contracts";

/** One line per Followed topic, for interpolation into the task prompt below. */
export function renderFollowedTopics(topics: FollowedTopic[]): string {
  return topics.map((topic) => `- ${topic.topic}`).join("\n");
}

/**
 * The daily digest's task prompt, run in the Muse's own Feed-log thread (its own working
 * history for this recurring research, distinct from the Conversation and any Goal log).
 * Every Followed topic is interpolated directly since there is no automatic per-run
 * context for topics the way `<goals_active>` covers Goals (goals-context.ts, B5).
 */
export function renderFeedTopicsTaskPrompt(topics: FollowedTopic[]): string {
  return `Research the person's Followed topics for today's Feed digest (background session).

Followed topics:
${renderFollowedTopics(topics)}

Instructions:
- For each topic, use your web tools to check for anything genuinely new since you last looked (your own prior research is in this thread's history above, if any).
- When you find something worth telling the person, call feed_add_topic_post with a short title, a one-to-three sentence body, and the sourceUrl you found it at. Write 1-3 Posts in total across all topics — skip a topic entirely if there is nothing new.
- Do not invent findings or sources: only post something you actually found via a tool call, with the real URL.
- End your reply with a brief one-sentence note of what you posted or that there was nothing new; this is not shown to the person, so keep it short.`;
}
