import type { FollowedTopic, Idea, Post } from "@aiden/contracts";

// Sample data behind the Muse procedures whose backend packages haven't landed yet
// (docs/muse/PLAN.md, "frontend first"). Each backend package replaces the matching
// part; delete this file once the Feed's posts, ideas, and topics are real. (goals.*
// is already real: see goals.ts. muse.settings / muse.updateSettings and asks.* / the
// Feed's asks are also real: see muse-settings.ts and muse-asks.ts.)
// State is in memory and shared by every caller: preview only, never production data.

type PreviewState = {
  posts: Post[];
  topics: FollowedTopic[];
  ideas: Idea[];
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
    ideas: [
      idea("idea-1", "Quiz me on today's 10 Japanese phrases", "learning"),
      idea("idea-2", "Find a ryokan in Kyoto under $200 a night", "travel"),
      idea("idea-3", "Plan this Sunday's long run route", "health"),
      idea("idea-4", "Summarize this week's AI agent news", "work"),
      idea("idea-5", "Draft a Moroccan-style landing page for my portfolio", "creative"),
      idea("idea-6", "What should I pack for Kyoto in December?", "travel"),
    ],
  };
}

function idea(id: string, text: string, area: string): Idea {
  return { id, text, area, createdAt: hoursAgo(1) };
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
  ideas: {
    list: (): Idea[] => current().ideas,
    refresh(): Idea[] {
      const preview = current();
      preview.ideas = [...preview.ideas.slice(1), preview.ideas[0]].filter((item): item is Idea =>
        Boolean(item),
      );
      return preview.ideas;
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
