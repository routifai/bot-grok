import type { MessageBlock } from "@aiden/contracts";
import type { PrismaClient } from "@aiden/db";
import { describe, expect, it, vi } from "vitest";
import { acceptGoalProposal, dismissGoalProposal } from "./goal-proposals.js";
import {
  createGoalFromTool,
  getGoalFromTool,
  listGoalsFromTool,
  proposeGoalPlanFromTool,
  updateGoalTaskFromTool,
} from "./goal-tools.js";

// An in-memory Prisma-shaped store, just enough for goal-tools.ts / goal-proposals.ts to
// run their real transactions (including the real createThreadMessageInTransaction /
// appendEventInTransaction from @aiden/db) without a database. Mirrors the one
// GOAL_INCLUDE shape (tasks by idx asc, at most one open proposal) used everywhere Goal
// rows are read.
function createFixture() {
  let seq = 0;
  const nextId = (prefix: string) => `${prefix}-${++seq}`;

  const goals: Record<string, unknown>[] = [];
  const tasks: Record<string, unknown>[] = [];
  const proposals: Record<string, unknown>[] = [];
  const threads: Record<string, unknown>[] = [];
  const messages: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];

  function matches(row: Record<string, unknown>, where: Record<string, unknown> = {}): boolean {
    return Object.entries(where).every(([key, value]) => {
      if (value && typeof value === "object" && "in" in (value as object)) {
        return (value as { in: unknown[] }).in.includes(row[key]);
      }
      return row[key] === value;
    });
  }

  function applyIncrements(row: Record<string, unknown>, data: Record<string, unknown>) {
    const result: Record<string, unknown> = { ...data };
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === "object" && "increment" in (value as object)) {
        result[key] = (Number(row[key]) || 0) + (value as { increment: number }).increment;
      }
    }
    return result;
  }

  function withRelations(goal: Record<string, unknown>) {
    return {
      ...goal,
      tasks: tasks
        .filter((task) => task.goalId === goal.id)
        .sort((a, b) => Number(a.idx) - Number(b.idx)),
      proposals: proposals
        .filter((proposal) => proposal.goalId === goal.id && proposal.status === "open")
        .slice(0, 1),
    };
  }

  const client = {
    goal: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const now = new Date();
        const row = {
          description: "",
          status: "active",
          due: null,
          checkInCrons: [],
          timezone: "UTC",
          lastWorkedAt: null,
          nextWorkAt: null,
          createdAt: now,
          updatedAt: now,
          ...data,
          id: nextId("goal"),
        };
        goals.push(row);
        return row;
      },
      findUnique: async ({ where, include }: { where: { id: string }; include?: unknown }) => {
        const goal = goals.find((g) => g.id === where.id);
        if (!goal) return null;
        return include ? withRelations(goal) : goal;
      },
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        goals.find((g) => matches(g, where)) ?? null,
      findMany: async ({
        where,
        include,
      }: {
        where?: Record<string, unknown>;
        include?: unknown;
      }) => {
        const filtered = goals.filter((g) => matches(g, where));
        return filtered.map((g) => (include ? withRelations(g) : g));
      },
    },
    goalTask: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          status: "pending",
          note: "",
          updatedAt: new Date(),
          ...data,
          id: nextId("task"),
        };
        tasks.push(row);
        return row;
      },
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        tasks.find((t) => matches(t, where)) ?? null,
      findMany: async ({ where }: { where?: Record<string, unknown> }) =>
        tasks.filter((t) => matches(t, where)),
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const task = tasks.find((t) => t.id === where.id);
        if (!task) throw new Error("task not found");
        Object.assign(task, data, { updatedAt: new Date() });
        return task;
      },
      deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
        const toDelete = tasks.filter((t) => matches(t, where));
        for (const task of toDelete) tasks.splice(tasks.indexOf(task), 1);
        return { count: toDelete.length };
      },
    },
    goalProposal: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          askMessageId: null,
          decidedAt: null,
          createdAt: new Date(),
          ...data,
          id: nextId("proposal"),
        };
        proposals.push(row);
        return row;
      },
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        proposals.find((p) => matches(p, where)) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const proposal = proposals.find((p) => p.id === where.id);
        if (!proposal) throw new Error("proposal not found");
        Object.assign(proposal, data);
        return proposal;
      },
    },
    thread: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          nextMessageSeq: 0,
          nextEventSeq: 0,
          unread: false,
          botId: null,
          groupId: null,
          goalId: null,
          ...data,
          id: nextId("thread"),
        };
        threads.push(row);
        return row;
      },
      findUnique: async ({ where }: { where: Record<string, unknown> }) =>
        threads.find((t) => matches(t, where)) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const thread = threads.find((t) => t.id === where.id);
        if (!thread) throw new Error("thread not found");
        Object.assign(thread, applyIncrements(thread, data));
        return thread;
      },
    },
    message: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { createdAt: new Date(), ...data, id: nextId("message") };
        messages.push(row);
        return row;
      },
      findUnique: async ({ where }: { where: { id: string } }) =>
        messages.find((m) => m.id === where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const message = messages.find((m) => m.id === where.id);
        if (!message) throw new Error("message not found");
        Object.assign(message, data);
        return message;
      },
    },
    event: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { createdAt: new Date(), ...data, id: nextId("event") };
        events.push(row);
        return row;
      },
    },
    run: {
      // The `goals` tool always runs mid-turn, so its Asks name a live run
      // (assertRunCanWriteHistory only rejects a missing or cancelled one).
      findUnique: async () => ({ status: "running", startedAt: new Date() }),
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(client),
  };

  return {
    prisma: client as unknown as PrismaClient,
    goals,
    tasks,
    proposals,
    threads,
    messages,
    events,
  };
}

const scope = { spaceId: "space-1", botId: "bot-1", userId: "user-1", runId: "run-1" };

function seedConversationThread(fixture: ReturnType<typeof createFixture>) {
  fixture.threads.push({
    id: "thread-conversation",
    spaceId: scope.spaceId,
    userId: scope.userId,
    botId: scope.botId,
    groupId: null,
    goalId: null,
    nextMessageSeq: 0,
    nextEventSeq: 0,
    unread: false,
  });
}

function askBlockOf(
  fixture: ReturnType<typeof createFixture>,
  messageId: string | null | undefined,
) {
  const message = fixture.messages.find((m) => m.id === messageId);
  const blocks = (message?.blocks as MessageBlock[] | undefined) ?? [];
  return blocks.find((block) => block.kind === "ask");
}

describe("goals tool: create", () => {
  it("creates an active Goal with no live tasks and an open first-plan Proposal", async () => {
    const fixture = createFixture();
    seedConversationThread(fixture);

    const result = await createGoalFromTool({ prisma: fixture.prisma }, scope, {
      title: "Conversational Japanese before Kyoto",
      description: "30 minutes a day",
      due: "2026-12-01",
      checkIn: ["30 7 * * 1-5"],
      tasks: ["Pick a course", "Book trial lessons"],
    });

    expect("error" in result).toBe(false);
    if ("error" in result) throw new Error("unexpected error");
    expect(result.goal.status).toBe("active");
    expect(result.goal.tasks).toEqual([]);
    expect(result.goal.due).toBe("2026-12-01");
    expect(result.goal.checkInCrons).toEqual(["30 7 * * 1-5"]);
    expect(result.goal.openProposal).toMatchObject({
      reason: "First plan",
      status: "open",
      tasks: [{ title: "Pick a course" }, { title: "Book trial lessons" }],
    });

    // A Goal log thread exists for this goal.
    expect(fixture.threads.some((t) => t.goalId === result.goal.id)).toBe(true);

    // The first plan posted an Ask into the Conversation thread.
    const askMessage = fixture.messages.find((m) => m.threadId === "thread-conversation");
    expect(askMessage).toBeDefined();
    const block = askBlockOf(fixture, askMessage?.id as string);
    expect(block).toMatchObject({
      kind: "ask",
      status: "pending",
      actions: [
        { id: "accept", label: "Accept plan" },
        { id: "dismiss", label: "Keep current" },
      ],
    });
    expect(fixture.proposals[0]?.askMessageId).toBe(askMessage?.id);
  });

  it("rejects a missing title or empty task list", async () => {
    const fixture = createFixture();
    seedConversationThread(fixture);

    expect(
      await createGoalFromTool({ prisma: fixture.prisma }, scope, { title: "", tasks: ["x"] }),
    ).toEqual({ error: "title is required." });

    expect(
      await createGoalFromTool({ prisma: fixture.prisma }, scope, { title: "Goal", tasks: [] }),
    ).toEqual({ error: "tasks must include at least one item for the first plan." });
  });
});

describe("goals tool: get / list", () => {
  it("returns a Goal scoped to its own Muse and not another bot's", async () => {
    const fixture = createFixture();
    seedConversationThread(fixture);
    const created = await createGoalFromTool({ prisma: fixture.prisma }, scope, {
      title: "Run a half marathon",
      tasks: ["Register"],
    });
    if ("error" in created) throw new Error("unexpected error");

    const found = await getGoalFromTool(
      { prisma: fixture.prisma },
      { botId: scope.botId },
      {
        goalId: created.goal.id,
      },
    );
    expect(found).toEqual({ goal: created.goal });

    const notFound = await getGoalFromTool(
      { prisma: fixture.prisma },
      { botId: "other-bot" },
      { goalId: created.goal.id },
    );
    expect(notFound).toEqual({ error: "Goal not found." });
  });

  it("lists this Muse's goals", async () => {
    const fixture = createFixture();
    seedConversationThread(fixture);
    await createGoalFromTool({ prisma: fixture.prisma }, scope, { title: "Goal A", tasks: ["a"] });
    await createGoalFromTool({ prisma: fixture.prisma }, scope, { title: "Goal B", tasks: ["b"] });

    const { goals } = await listGoalsFromTool({ prisma: fixture.prisma }, { botId: scope.botId });
    expect(goals.map((g) => g.title).sort()).toEqual(["Goal A", "Goal B"]);
  });
});

describe("goals tool: update_task", () => {
  async function goalWithOneAcceptedTask(fixture: ReturnType<typeof createFixture>) {
    const created = await createGoalFromTool({ prisma: fixture.prisma }, scope, {
      title: "Learn Japanese",
      tasks: ["Book trial lessons"],
    });
    if ("error" in created) throw new Error("unexpected error");
    const accepted = await acceptGoalProposal(
      { prisma: fixture.prisma },
      created.goal.openProposal!.id,
    );
    if (!accepted) throw new Error("accept failed");
    return accepted;
  }

  it("updates a task's progress without touching the plan's shape", async () => {
    const fixture = createFixture();
    seedConversationThread(fixture);
    const goal = await goalWithOneAcceptedTask(fixture);
    const taskId = goal.tasks[0]!.id;

    const result = await updateGoalTaskFromTool({ prisma: fixture.prisma }, scope, {
      goalId: goal.id,
      taskId,
      status: "in_progress",
      note: "Booked two lessons",
    });
    if ("error" in result) throw new Error("unexpected error");
    expect(result.goal.tasks).toHaveLength(1);
    expect(result.goal.tasks[0]).toMatchObject({
      status: "in_progress",
      note: "Booked two lessons",
    });
  });

  it("opens a blocked_task Ask only when a blocked task carries a note, and only once", async () => {
    const fixture = createFixture();
    seedConversationThread(fixture);
    const goal = await goalWithOneAcceptedTask(fixture);
    const taskId = goal.tasks[0]!.id;

    const blockedNoNote = await updateGoalTaskFromTool({ prisma: fixture.prisma }, scope, {
      goalId: goal.id,
      taskId,
      status: "blocked",
    });
    if ("error" in blockedNoNote) throw new Error("unexpected error");
    expect(fixture.messages).toHaveLength(1); // only the create-time proposal Ask so far

    const blockedWithNote = await updateGoalTaskFromTool({ prisma: fixture.prisma }, scope, {
      goalId: goal.id,
      taskId,
      status: "pending",
    });
    if ("error" in blockedWithNote) throw new Error("unexpected error");

    const blocked = await updateGoalTaskFromTool({ prisma: fixture.prisma }, scope, {
      goalId: goal.id,
      taskId,
      status: "blocked",
      note: "Which evenings work for trial lessons?",
    });
    if ("error" in blocked) throw new Error("unexpected error");
    const askMessages = fixture.messages.filter((m) => m.threadId === "thread-conversation");
    expect(askMessages).toHaveLength(2);
    const block = askBlockOf(fixture, askMessages[1]?.id as string);
    expect(block).toMatchObject({
      kind: "ask",
      text: "Which evenings work for trial lessons?",
      input: "text",
      status: "pending",
      // The explicit marker apps/api/src/muse-asks.ts (B6) routes a blocked-Task
      // answer on, instead of guessing the kind from the thread/shape.
      goalTaskId: taskId,
    });

    // Calling update_task again while already blocked (same status) does not re-ask.
    const stillBlocked = await updateGoalTaskFromTool({ prisma: fixture.prisma }, scope, {
      goalId: goal.id,
      taskId,
      status: "blocked",
      note: "Which evenings work for trial lessons?",
    });
    if ("error" in stillBlocked) throw new Error("unexpected error");
    expect(fixture.messages.filter((m) => m.threadId === "thread-conversation")).toHaveLength(2);
  });

  it("returns not found for a goal or task outside this Muse's scope", async () => {
    const fixture = createFixture();
    seedConversationThread(fixture);
    const goal = await goalWithOneAcceptedTask(fixture);

    expect(
      await updateGoalTaskFromTool(
        { prisma: fixture.prisma },
        { ...scope, botId: "other-bot" },
        {
          goalId: goal.id,
          taskId: goal.tasks[0]!.id,
          status: "done",
        },
      ),
    ).toEqual({ error: "Goal not found." });

    expect(
      await updateGoalTaskFromTool({ prisma: fixture.prisma }, scope, {
        goalId: goal.id,
        taskId: "missing-task",
        status: "done",
      }),
    ).toEqual({ error: "Task not found." });
  });
});

describe("goals tool: propose", () => {
  it("keeps at most one open Proposal per Goal — a second propose withdraws the first", async () => {
    const fixture = createFixture();
    seedConversationThread(fixture);
    const created = await createGoalFromTool({ prisma: fixture.prisma }, scope, {
      title: "Learn Japanese",
      tasks: ["Pick a course"],
    });
    if ("error" in created) throw new Error("unexpected error");
    const firstProposalId = created.goal.openProposal!.id;
    const firstAskMessageId = fixture.proposals[0]?.askMessageId as string;

    const proposed = await proposeGoalPlanFromTool({ prisma: fixture.prisma }, scope, {
      goalId: created.goal.id,
      reason: "Two tutors only teach on weekends",
      tasks: [{ title: "Pick a course" }, { title: "Join a Saturday club" }],
    });
    if ("error" in proposed) throw new Error("unexpected error");

    expect(proposed.goal.openProposal?.id).not.toBe(firstProposalId);
    expect(proposed.goal.openProposal?.status).toBe("open");
    expect(fixture.proposals.filter((p) => p.status === "open")).toHaveLength(1);

    const firstProposalRow = fixture.proposals.find((p) => p.id === firstProposalId);
    expect(firstProposalRow?.status).toBe("withdrawn");
    const firstBlock = askBlockOf(fixture, firstAskMessageId);
    expect(firstBlock).toMatchObject({ status: "answered", answer: "withdrawn" });

    // The new proposal's own Ask is still open.
    const secondAskMessageId = fixture.proposals.find((p) => p.status === "open")
      ?.askMessageId as string;
    const secondBlock = askBlockOf(fixture, secondAskMessageId);
    expect(secondBlock).toMatchObject({ status: "pending" });
  });

  it("rejects an empty reason or task list", async () => {
    const fixture = createFixture();
    seedConversationThread(fixture);
    const created = await createGoalFromTool({ prisma: fixture.prisma }, scope, {
      title: "Learn Japanese",
      tasks: ["Pick a course"],
    });
    if ("error" in created) throw new Error("unexpected error");

    expect(
      await proposeGoalPlanFromTool({ prisma: fixture.prisma }, scope, {
        goalId: created.goal.id,
        reason: "",
        tasks: [{ title: "x" }],
      }),
    ).toEqual({ error: "reason is required." });

    expect(
      await proposeGoalPlanFromTool({ prisma: fixture.prisma }, scope, {
        goalId: created.goal.id,
        reason: "why",
        tasks: [],
      }),
    ).toEqual({ error: "tasks must be a non-empty list of {title, keepTaskId?}." });
  });
});

describe("accepting and dismissing a Proposal (answer path)", () => {
  it("accept replaces the plan, keeping keepTaskId tasks' status and notes", async () => {
    const fixture = createFixture();
    seedConversationThread(fixture);
    const created = await createGoalFromTool({ prisma: fixture.prisma }, scope, {
      title: "Learn Japanese",
      tasks: ["Pick a course", "Book trial lessons"],
    });
    if ("error" in created) throw new Error("unexpected error");
    const firstAccept = await acceptGoalProposal(
      { prisma: fixture.prisma },
      created.goal.openProposal!.id,
    );
    if (!firstAccept) throw new Error("accept failed");

    // Progress the plan a bit before it's revised.
    const keptTask = firstAccept.tasks.find((t) => t.title === "Pick a course")!;
    await updateGoalTaskFromTool({ prisma: fixture.prisma }, scope, {
      goalId: firstAccept.id,
      taskId: keptTask.id,
      status: "done",
      note: "Chose Genki I",
    });

    const proposed = await proposeGoalPlanFromTool({ prisma: fixture.prisma }, scope, {
      goalId: firstAccept.id,
      reason: "Add a weekend club",
      tasks: [
        { title: "Pick a course", keepTaskId: keptTask.id },
        { title: "Join a Saturday club" },
      ],
    });
    if ("error" in proposed) throw new Error("unexpected error");

    const accepted = await acceptGoalProposal(
      { prisma: fixture.prisma },
      proposed.goal.openProposal!.id,
    );
    expect(accepted).not.toBeNull();
    expect(accepted!.tasks.map((t) => t.title)).toEqual(["Pick a course", "Join a Saturday club"]);
    const carried = accepted!.tasks.find((t) => t.title === "Pick a course")!;
    expect(carried).toMatchObject({ id: keptTask.id, status: "done", note: "Chose Genki I" });
    const added = accepted!.tasks.find((t) => t.title === "Join a Saturday club")!;
    expect(added).toMatchObject({ status: "pending", note: "" });
    // The dropped task ("Book trial lessons") is gone.
    expect(accepted!.tasks.some((t) => t.title === "Book trial lessons")).toBe(false);
    expect(accepted!.openProposal).toBeNull();

    const askMessageId = fixture.proposals.find((p) => p.id === proposed.goal.openProposal!.id)
      ?.askMessageId as string;
    expect(askBlockOf(fixture, askMessageId)).toMatchObject({
      status: "answered",
      answer: "accept",
    });
  });

  it("dismiss leaves the current plan untouched", async () => {
    const fixture = createFixture();
    seedConversationThread(fixture);
    const created = await createGoalFromTool({ prisma: fixture.prisma }, scope, {
      title: "Learn Japanese",
      tasks: ["Pick a course"],
    });
    if ("error" in created) throw new Error("unexpected error");
    const accepted = await acceptGoalProposal(
      { prisma: fixture.prisma },
      created.goal.openProposal!.id,
    );
    if (!accepted) throw new Error("accept failed");

    const proposed = await proposeGoalPlanFromTool({ prisma: fixture.prisma }, scope, {
      goalId: accepted.id,
      reason: "Try a different course",
      tasks: [{ title: "Pick a different course" }],
    });
    if ("error" in proposed) throw new Error("unexpected error");

    const dismissed = await dismissGoalProposal(
      { prisma: fixture.prisma },
      proposed.goal.openProposal!.id,
    );
    expect(dismissed).not.toBeNull();
    expect(dismissed!.tasks.map((t) => t.title)).toEqual(["Pick a course"]);
    expect(dismissed!.openProposal).toBeNull();
    const proposalRow = fixture.proposals.find((p) => p.id === proposed.goal.openProposal!.id);
    expect(proposalRow?.status).toBe("dismissed");
    expect(askBlockOf(fixture, proposalRow?.askMessageId as string)).toMatchObject({
      status: "answered",
      answer: "dismiss",
    });
  });

  it("returns null for a proposal that is not open (already decided)", async () => {
    const fixture = createFixture();
    seedConversationThread(fixture);
    const created = await createGoalFromTool({ prisma: fixture.prisma }, scope, {
      title: "Learn Japanese",
      tasks: ["Pick a course"],
    });
    if ("error" in created) throw new Error("unexpected error");
    const proposalId = created.goal.openProposal!.id;
    await acceptGoalProposal({ prisma: fixture.prisma }, proposalId);

    expect(await acceptGoalProposal({ prisma: fixture.prisma }, proposalId)).toBeNull();
    expect(await dismissGoalProposal({ prisma: fixture.prisma }, proposalId)).toBeNull();
    expect(await acceptGoalProposal({ prisma: fixture.prisma }, "missing")).toBeNull();
  });
});

describe("acceptGoalProposal / dismissGoalProposal: ideas refresh (B11)", () => {
  it("enqueues an ideas.refresh job for the goal's bot when a proposal is accepted", async () => {
    const fixture = createFixture();
    seedConversationThread(fixture);
    const jobs = { enqueue: vi.fn(async () => undefined), cancel: vi.fn(), close: vi.fn() };
    const created = await createGoalFromTool({ prisma: fixture.prisma }, scope, {
      title: "Learn Japanese",
      tasks: ["Pick a course"],
    });
    if ("error" in created) throw new Error("unexpected error");

    await acceptGoalProposal({ prisma: fixture.prisma, jobs }, created.goal.openProposal!.id);

    expect(jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "ideas.refresh", payload: { botId: scope.botId } }),
    );
  });

  it("also enqueues on dismiss, and never throws when enqueue itself fails", async () => {
    const fixture = createFixture();
    seedConversationThread(fixture);
    const jobs = {
      enqueue: vi.fn(async () => {
        throw new Error("queue unavailable");
      }),
      cancel: vi.fn(),
      close: vi.fn(),
    };
    const created = await createGoalFromTool({ prisma: fixture.prisma }, scope, {
      title: "Learn Japanese",
      tasks: ["Pick a course"],
    });
    if ("error" in created) throw new Error("unexpected error");

    await expect(
      dismissGoalProposal({ prisma: fixture.prisma, jobs }, created.goal.openProposal!.id),
    ).resolves.not.toBeNull();
    expect(jobs.enqueue).toHaveBeenCalledOnce();
  });

  it("does nothing when no job publisher is given", async () => {
    const fixture = createFixture();
    seedConversationThread(fixture);
    const created = await createGoalFromTool({ prisma: fixture.prisma }, scope, {
      title: "Learn Japanese",
      tasks: ["Pick a course"],
    });
    if ("error" in created) throw new Error("unexpected error");

    await expect(
      acceptGoalProposal({ prisma: fixture.prisma }, created.goal.openProposal!.id),
    ).resolves.not.toBeNull();
  });
});
