import { ORPCError } from "@orpc/server";
import type {
  Ask,
  Feed,
  FollowedTopic,
  Goal,
  Idea,
  MuseSettings,
  Post,
  ThreadMessagePage,
} from "@rakazo/contracts";
import { DEFAULT_MUSE_SETTINGS } from "@rakazo/contracts";

// Sample data behind the Muse procedures so the frontend can be built and felt before the
// backend lands (docs/muse/PLAN.md, "frontend first"). Each backend package replaces the
// matching part; delete this file once goals, asks, feed, ideas, topics, and settings are real.
// State is in memory and shared by every caller: preview only, never production data.

type PreviewState = {
  goals: Goal[];
  asks: Ask[];
  posts: Post[];
  topics: FollowedTopic[];
  ideas: Idea[];
  settings: MuseSettings;
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
    asks: [
      {
        id: "ask-proposal-japanese",
        runId: "run-preview-1",
        kind: "proposal",
        goalId: japanese.id,
        goalTitle: japanese.title,
        text: "Add a Saturday conversation club to the plan?",
        detail: japanese.openProposal?.reason,
        choices: [
          { id: "accept", label: "Accept" },
          { id: "dismiss", label: "Dismiss" },
        ],
        input: null,
        createdAt: hoursAgo(3),
      },
      {
        id: "ask-blocked-japanese",
        runId: "run-preview-1",
        kind: "blocked_task",
        goalId: japanese.id,
        goalTitle: japanese.title,
        text: "Which evenings work for trial lessons?",
        choices: [
          { id: "mon-wed", label: "Mon and Wed" },
          { id: "tue-thu", label: "Tue and Thu" },
          { id: "any", label: "Any weekday" },
        ],
        input: null,
        createdAt: hoursAgo(2),
      },
      {
        id: "ask-approval-email",
        runId: "run-preview-2",
        kind: "approval",
        goalId: null,
        goalTitle: null,
        text: "Review before sending an email to the running club organizer",
        detail: "To: organizer@example.com\nSubject: Joining Sunday long runs",
        choices: [
          { id: "allow", label: "Send" },
          { id: "deny", label: "Don't send" },
        ],
        input: null,
        createdAt: hoursAgo(1),
      },
    ],
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
    ideas: [
      idea("idea-1", "Quiz me on today's 10 Japanese phrases", "learning"),
      idea("idea-2", "Find a ryokan in Kyoto under $200 a night", "travel"),
      idea("idea-3", "Plan this Sunday's long run route", "health"),
      idea("idea-4", "Summarize this week's AI agent news", "work"),
      idea("idea-5", "Draft a Moroccan-style landing page for my portfolio", "creative"),
      idea("idea-6", "What should I pack for Kyoto in December?", "travel"),
    ],
    settings: { ...DEFAULT_MUSE_SETTINGS },
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

function idea(id: string, text: string, area: string): Idea {
  return { id, text, area, createdAt: hoursAgo(1) };
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
  if (state)
    state.asks = state.asks.filter((ask) => !(ask.kind === "proposal" && ask.goalId === goal.id));
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
  asks: {
    list: (botId: string): Ask[] => current(botId).asks,
    count: (botId: string) => ({ count: current(botId).asks.length }),
    answer(input: { askId: string; answer: string }): { ok: true } {
      const ask = state?.asks.find((candidate) => candidate.id === input.askId);
      if (!ask) throw new ORPCError("NOT_FOUND");
      if (ask.kind === "proposal" && ask.goalId) {
        const goal = findGoal(ask.goalId);
        if (goal.openProposal) closeProposal(goal, input.answer === "accept");
      }
      if (state) state.asks = state.asks.filter((candidate) => candidate.id !== input.askId);
      return { ok: true };
    },
  },
  feed: {
    list(botId: string): Feed {
      const preview = current(botId);
      return { asks: preview.asks, posts: preview.posts, nextCursor: null };
    },
  },
  ideas: {
    list: (botId: string): Idea[] => current(botId).ideas,
    refresh(botId: string): Idea[] {
      const preview = current(botId);
      preview.ideas = [...preview.ideas.slice(1), preview.ideas[0]].filter((item): item is Idea =>
        Boolean(item),
      );
      return preview.ideas;
    },
  },
  topics: {
    list: (botId: string): FollowedTopic[] => current(botId).topics,
    remove(topicId: string): { ok: true } {
      if (state) state.topics = state.topics.filter((topic) => topic.id !== topicId);
      return { ok: true };
    },
  },
  settings: {
    get: (botId: string): MuseSettings => current(botId).settings,
    update(botId: string, patch: Partial<MuseSettings>): MuseSettings {
      const preview = current(botId);
      preview.settings = { ...preview.settings, ...patch };
      return preview.settings;
    },
  },
};
