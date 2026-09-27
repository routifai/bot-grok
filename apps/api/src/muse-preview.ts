import type { FollowedTopic, Goal, Post, ThreadMessagePage } from "@aiden/contracts";
import { ORPCError } from "@orpc/server";

// Sample data behind the Muse procedures so the frontend can be built and felt before the
// backend lands (docs/muse/PLAN.md, "frontend first"). Each backend package replaces the
// matching part; delete this file once goals, feed posts, and topics are real.
// (muse.settings / muse.updateSettings, asks.* / the Feed's asks, and ideas.* are already
// real: see muse-settings.ts, muse-asks.ts, and muse-ideas.ts.)
// State is in memory and shared by every caller: preview only, never production data.

type PreviewState = {
  goals: Goal[];
  posts: Post[];
  topics: FollowedTopic[];
};

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
const hoursAhead = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

function seed(botId: string): PreviewState {
  const japanese: Goal = {
    id: "goal-japanese",
    botId,
    title: "Conversational Japanese before Kyoto",
    description: "Hold a simple conversation in Japanese by the December trip. 30 minutes a day.",
    status: "active",
    due: "2026-12-10",
    checkInCrons: ["30 7 * * 1-5"],
    timezone: "America/New_York",
    tasks: [
      task(
        "goal-japanese",
        0,
        "Pick a course that fits 30 minutes a day",
        "done",
        "Chose Genki I with the companion app.",
      ),
      task(
        "goal-japanese",
        1,
        "Book three trial lessons with tutors",
        "blocked",
        "Needs your available evenings.",
      ),
      task("goal-japanese", 2, "Daily practice streak: 30 minutes", "in_progress", "Day 4 of 30."),
      task("goal-japanese", 3, "Learn 50 travel phrases for Kyoto", "pending", ""),
    ],
    openProposal: {
      id: "proposal-japanese",
      goalId: "goal-japanese",
      reason:
        "Two tutors only teach on weekends. Adding a weekend conversation club keeps the pace.",
      tasks: [
        { title: "Pick a course that fits 30 minutes a day" },
        { title: "Book three trial lessons with tutors" },
        { title: "Join a Saturday conversation club" },
        { title: "Daily practice streak: 30 minutes" },
        { title: "Learn 50 travel phrases for Kyoto" },
      ],
      status: "open",
      createdAt: hoursAgo(3),
    },
    lastWorkedAt: hoursAgo(2),
    nextWorkAt: hoursAhead(1),
    createdAt: hoursAgo(96),
    updatedAt: hoursAgo(2),
  };
  const halfMarathon: Goal = {
    id: "goal-half-marathon",
    botId,
    title: "Run a half marathon in spring",
    description: "Finish the April city half marathon without walking.",
    status: "active",
    due: "2027-04-18",
    checkInCrons: ["0 9 * * 0"],
    timezone: "America/New_York",
    tasks: [
      task(
        "goal-half-marathon",
        0,
        "Register for the April race",
        "done",
        "Registered, bib pickup April 16.",
      ),
      task(
        "goal-half-marathon",
        1,
        "Build a 16-week training plan",
        "done",
        "Saved as training-plan.md in the Library.",
      ),
      task("goal-half-marathon", 2, "Find a running group for long runs", "pending", ""),
    ],
    openProposal: null,
    lastWorkedAt: hoursAgo(20),
    nextWorkAt: hoursAhead(4),
    createdAt: hoursAgo(300),
    updatedAt: hoursAgo(20),
  };
  return {
    goals: [japanese, halfMarathon],
    posts: [
      {
        id: "post-1",
        kind: "goal_report",
        title: "Chose your Japanese course",
        body: "Compared four options for 30 minutes a day. Genki I with the companion app fits best; the comparison is in the Library.",
        goalId: japanese.id,
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
        goalId: halfMarathon.id,
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

function task(
  goalId: string,
  idx: number,
  title: string,
  status: Goal["tasks"][number]["status"],
  note: string,
): Goal["tasks"][number] {
  return {
    id: `${goalId}-task-${idx}`,
    goalId,
    idx,
    title,
    status,
    note,
    updatedAt: hoursAgo(idx + 1),
  };
}

let state: PreviewState | undefined;

function current(botId: string): PreviewState {
  state ??= seed(botId);
  return state;
}

function findGoal(goalId: string): Goal {
  const goal = state?.goals.find((candidate) => candidate.id === goalId);
  if (!goal) throw new ORPCError("NOT_FOUND");
  return goal;
}

function goalByProposal(proposalId: string): Goal {
  const goal = state?.goals.find((candidate) => candidate.openProposal?.id === proposalId);
  if (!goal) throw new ORPCError("NOT_FOUND");
  return goal;
}

function closeProposal(goal: Goal, accept: boolean): Goal {
  const proposal = goal.openProposal;
  if (!proposal) return goal;
  if (accept) {
    goal.tasks = proposal.tasks.map((proposed, idx) => {
      const existing = goal.tasks.find((candidate) => candidate.title === proposed.title);
      return existing
        ? { ...existing, idx }
        : {
            ...task(goal.id, idx, proposed.title, "pending", ""),
            id: `${goal.id}-task-new-${idx}`,
          };
    });
  }
  goal.openProposal = null;
  goal.updatedAt = new Date().toISOString();
  return goal;
}

export const musePreview = {
  goals: {
    list(botId: string, includeClosed = false): Goal[] {
      return current(botId).goals.filter(
        (goal) => includeClosed || goal.status === "active" || goal.status === "paused",
      );
    },
    get: (goalId: string): Goal => findGoal(goalId),
    update(input: {
      goalId: string;
      status?: "active" | "paused" | "cancelled";
      checkInCrons?: string[];
      timezone?: string;
    }): Goal {
      const goal = findGoal(input.goalId);
      if (input.status) goal.status = input.status;
      if (input.checkInCrons) goal.checkInCrons = input.checkInCrons;
      if (input.timezone) goal.timezone = input.timezone;
      goal.updatedAt = new Date().toISOString();
      return goal;
    },
    acceptProposal: (proposalId: string): Goal => closeProposal(goalByProposal(proposalId), true),
    dismissProposal: (proposalId: string): Goal => closeProposal(goalByProposal(proposalId), false),
    log(goalId: string): ThreadMessagePage {
      const goal = findGoal(goalId);
      const threadId = `thread-${goal.id}`;
      const lines = goal.tasks
        .filter((item) => item.note)
        .map((item) => `${item.title}: ${item.note}`);
      return {
        threadId,
        olderCursor: null,
        messages: lines.map((text, seq) => ({
          id: `${threadId}-message-${seq}`,
          threadId,
          seq,
          role: "bot" as const,
          blocks: [{ kind: "text" as const, text }],
          botId: goal.botId,
          createdAt: hoursAgo(lines.length - seq),
        })),
      };
    },
  },
  feed: {
    /** Posts only now: the Feed's asks come from the real `listAsks` (muse-asks.ts). */
    list(botId: string): { posts: Post[]; nextCursor: string | null } {
      const preview = current(botId);
      return { posts: preview.posts, nextCursor: null };
    },
  },
  topics: {
    list: (botId: string): FollowedTopic[] => current(botId).topics,
    remove(topicId: string): { ok: true } {
      if (state) state.topics = state.topics.filter((topic) => topic.id !== topicId);
      return { ok: true };
    },
  },
};
