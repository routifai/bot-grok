import type { Goal } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  type GoalsContextRepo,
  loadGoalsContext,
  renderConversationSummaryContext,
  renderGoalsContext,
} from "./goals-context.js";

function goal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "goal-1",
    botId: "bot-1",
    title: "Conversational Japanese before Kyoto",
    description: "Get to a comfortable conversational level before the December trip.",
    status: "active",
    due: "2026-12-01",
    checkInCrons: ["0 7 * * 1-5"],
    timezone: "UTC",
    tasks: [
      {
        id: "task-1",
        goalId: "goal-1",
        idx: 1,
        title: "Find a tutor",
        status: "done",
        note: "",
        updatedAt: "2026-09-01T00:00:00.000Z",
      },
      {
        id: "task-2",
        goalId: "goal-1",
        idx: 2,
        title: "Book weekly lessons",
        status: "in_progress",
        note: "waiting on tutor's calendar",
        updatedAt: "2026-09-02T00:00:00.000Z",
      },
    ],
    openProposal: null,
    lastWorkedAt: null,
    nextWorkAt: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("renderGoalsContext", () => {
  it("wraps the goal as data with title, due, check-in, and tasks with status + note", () => {
    const rendered = renderGoalsContext([goal()]);

    expect(rendered.startsWith("The Muse's Goals follow")).toBe(true);
    expect(rendered).toContain("<goals_active>");
    expect(rendered).toContain("</goals_active>");
    expect(rendered).toContain("Goal goal-1: Conversational Japanese before Kyoto");
    expect(rendered).toContain("status=active");
    expect(rendered).toContain("progress=1/2");
    expect(rendered).toContain("due=2026-12-01");
    expect(rendered).toContain("check_in=0 7 * * 1-5");
    expect(rendered).toContain("[x] 1. Find a tutor");
    expect(rendered).toContain("[~] 2. Book weekly lessons — waiting on tutor's calendar");
  });

  it("marks an active goal's due date OVERDUE only when it has passed", () => {
    const overdue = renderGoalsContext([goal({ due: "2000-01-01" })]);
    expect(overdue).toContain("due=2000-01-01 OVERDUE");

    const doneGoal = renderGoalsContext([goal({ due: "2000-01-01", status: "done" })]);
    expect(doneGoal).not.toContain("OVERDUE");
  });

  it("adds a line for an open proposal, and omits it when there is none", () => {
    const withProposal = renderGoalsContext([
      goal({
        openProposal: {
          id: "proposal-1",
          goalId: "goal-1",
          reason: "The tutor search stalled",
          tasks: [{ title: "Try a different tutor marketplace" }],
          status: "open",
          createdAt: "2026-09-03T00:00:00.000Z",
        },
      }),
    ]);
    expect(withProposal).toContain("proposal awaiting your answer: The tutor search stalled");
    expect(withProposal).toContain("Try a different tutor marketplace");

    expect(renderGoalsContext([goal()])).not.toContain("proposal awaiting your answer");
  });

  it("escapes angle brackets and ampersands in user-authored text", () => {
    const rendered = renderGoalsContext([goal({ title: "A & B <script>" })]);
    expect(rendered).toContain("A &amp; B &lt;script&gt;");
    expect(rendered).not.toContain("<script>");
  });

  it("stays within the byte cap and still closes the tag when goals overflow it", () => {
    const goals = Array.from({ length: 40 }, (_, i) =>
      goal({ id: `goal-${i}`, title: `Goal number ${i} with a fairly long descriptive title` }),
    );
    const rendered = renderGoalsContext(goals, 512);

    expect(Buffer.byteLength(rendered, "utf8")).toBeLessThanOrEqual(512);
    expect(rendered.endsWith("</goals_active>")).toBe(true);
  });

  it("truncates cleanly even when the cap is smaller than the fixed wrapper", () => {
    const rendered = renderGoalsContext([goal()], 10);
    expect(Buffer.byteLength(rendered, "utf8")).toBeLessThanOrEqual(10);
  });
});

describe("loadGoalsContext", () => {
  function repo(goals: Goal[]): GoalsContextRepo {
    return {
      listGoals: async () => goals,
      getGoal: async (goalId) => goals.find((g) => g.id === goalId) ?? null,
    };
  }

  it("returns undefined when the Muse has no active Goals", async () => {
    const result = await loadGoalsContext({ goals: repo([]) }, { botId: "bot-1" });
    expect(result).toBeUndefined();
  });

  it("lists every active Goal when no goalId is given (a Conversation turn)", async () => {
    const goalA = goal({ id: "goal-a", title: "Goal A" });
    const goalB = goal({ id: "goal-b", title: "Goal B" });
    const result = await loadGoalsContext({ goals: repo([goalA, goalB]) }, { botId: "bot-1" });
    expect(result).toContain("Goal A");
    expect(result).toContain("Goal B");
  });

  it("includes only the given Goal in full for a Goal-log turn, not the Muse's other Goals", async () => {
    const worked = goal({ id: "goal-a", title: "Goal being worked" });
    const other = goal({ id: "goal-b", title: "A different Goal" });
    const result = await loadGoalsContext(
      { goals: repo([worked, other]) },
      { botId: "bot-1", goalId: "goal-a" },
    );
    expect(result).toContain("Goal being worked");
    expect(result).not.toContain("A different Goal");
  });

  it("returns undefined when the Goal-log's goalId no longer resolves to a Goal", async () => {
    const result = await loadGoalsContext(
      { goals: repo([goal()]) },
      { botId: "bot-1", goalId: "missing" },
    );
    expect(result).toBeUndefined();
  });
});

describe("renderConversationSummaryContext", () => {
  it("returns undefined for an empty or missing summary", () => {
    expect(renderConversationSummaryContext(null)).toBeUndefined();
    expect(renderConversationSummaryContext(undefined)).toBeUndefined();
    expect(renderConversationSummaryContext("   ")).toBeUndefined();
  });

  it("wraps a non-empty summary as data inside <conversation_summary>", () => {
    const rendered = renderConversationSummaryContext("The person is planning a Kyoto trip.");
    expect(rendered).toContain("<conversation_summary>");
    expect(rendered).toContain("</conversation_summary>");
    expect(rendered).toContain("The person is planning a Kyoto trip.");
    expect(rendered?.startsWith("A summary of the Muse's Conversation")).toBe(true);
  });

  it("stays within the byte cap for a long summary", () => {
    const long = "x".repeat(10_000);
    const rendered = renderConversationSummaryContext(long, 256);
    expect(rendered).toBeDefined();
    expect(Buffer.byteLength(rendered as string, "utf8")).toBeLessThanOrEqual(256);
    expect(rendered?.endsWith("</conversation_summary>")).toBe(true);
  });
});
