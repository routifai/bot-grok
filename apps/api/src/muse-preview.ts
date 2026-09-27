import type { FollowedTopic, Post } from "@aiden/contracts";

// Sample data behind the Muse procedures whose backend packages haven't landed yet
// (docs/muse/PLAN.md, "frontend first"). Each backend package replaces the matching
// part; delete this file once the Feed's posts and topics are real. (goals.* and ideas.*
// are already real: see goals.ts, muse-ideas.ts. muse.settings / muse.updateSettings and asks.* / the
// Feed's asks are also real: see muse-settings.ts and muse-asks.ts.)
// State is in memory and shared by every caller: preview only, never production data.

type PreviewState = {
  posts: Post[];
  topics: FollowedTopic[];
};

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

function seed(): PreviewState {
  return {
    posts: [
      {
        id: "post-1",
        kind: "goal_report",
        title: "Chose your Japanese course",
        body: "Compared four options for 30 minutes a day. Genki I with the companion app fits best; the comparison is in the Library.",
        goalId: "goal-japanese",
        sourceUrl: null,
        createdAt: hoursAgo(2),
      },
      {
        id: "post-2",
        kind: "topic",
        title: "Agents that keep working in the background",
        body: "Two new open-source agents now run long tasks while the app is closed and ask for approval before sending anything.",
        goalId: null,
        sourceUrl: "https://example.com/agents-background-work",
        createdAt: hoursAgo(6),
      },
      {
        id: "post-3",
        kind: "goal_report",
        title: "Training plan ready",
        body: "Built a 16-week plan ending on race day, with long runs on Sundays.",
        goalId: "goal-half-marathon",
        sourceUrl: null,
        createdAt: hoursAgo(20),
      },
    ],
    topics: [
      { id: "topic-1", topic: "AI agent news", createdAt: hoursAgo(200) },
      { id: "topic-2", topic: "Moroccan design", createdAt: hoursAgo(150) },
    ],
  };
}

let state: PreviewState | undefined;

function current(): PreviewState {
  state ??= seed();
  return state;
}

export const musePreview = {
  feed: {
    /** Posts only: the Feed's asks come from the real `listAsks` (muse-asks.ts). */
    list(): { posts: Post[]; nextCursor: string | null } {
      return { posts: current().posts, nextCursor: null };
    },
  },
  topics: {
    list: (): FollowedTopic[] => current().topics,
    remove(topicId: string): { ok: true } {
      if (state) state.topics = state.topics.filter((topic) => topic.id !== topicId);
      return { ok: true };
    },
  },
};
