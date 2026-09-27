import { type BackgroundJob, museQueueName } from "@aiden/adapter-kit";
import { nextCronDateAcross, quietHoursEnd } from "@aiden/core";
import type { PrismaClient } from "@aiden/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGoalJobHandlers,
  rescheduleMuseGoalsForBot,
  scheduleGoalAdvance,
  scheduleGoalCheckin,
  wakeGoal,
} from "./goal-jobs.js";

// An in-memory Prisma-shaped store, just enough for goal-jobs.ts (and the real
// createGoalRepos / createThreadMessageInTransaction / appendEventInTransaction from
// @aiden/db that goal.checkin's rendering and goal.advance's report-posting call into).
// Mirrors the fixture pattern in goal-tools.test.ts.
function createFixture() {
  let seq = 0;
  const nextId = (prefix: string) => `${prefix}-${++seq}`;

  const goals: Record<string, unknown>[] = [];
  const goalTasks: Record<string, unknown>[] = [];
  const goalProposals: Record<string, unknown>[] = [];
  const bots: Record<string, unknown>[] = [];
  const threads: Record<string, unknown>[] = [];
  const tasks: Record<string, unknown>[] = [];
  const runs: Record<string, unknown>[] = [];
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

  function applySelect(row: Record<string, unknown>, select?: Record<string, true>) {
    if (!select) return row;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(select)) out[key] = row[key];
    return out;
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

  const client = {
    goal: {
      findUnique: async ({
        where,
        include,
        select,
      }: {
        where: { id: string };
        include?: { log?: boolean; tasks?: unknown; proposals?: unknown };
        select?: Record<string, true>;
      }) => {
        const goal = goals.find((g) => g.id === where.id);
        if (!goal) return null;
        if (select) return applySelect(goal, select);
        if (!include) return goal;
        const result: Record<string, unknown> = { ...goal };
        if (include.log) result.log = threads.find((t) => t.goalId === goal.id) ?? null;
        if (include.tasks) {
          result.tasks = goalTasks
            .filter((t) => t.goalId === goal.id)
            .sort((a, b) => Number(a.idx) - Number(b.idx));
        }
        if (include.proposals) {
          result.proposals = goalProposals
            .filter((p) => p.goalId === goal.id && p.status === "open")
            .slice(0, 1);
        }
        return result;
      },
      findMany: async ({
        where,
        select,
      }: {
        where?: Record<string, unknown>;
        select?: Record<string, true>;
      }) => goals.filter((g) => matches(g, where)).map((g) => applySelect(g, select)),
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const goal = goals.find((g) => g.id === where.id);
        if (!goal) throw new Error("goal not found");
        Object.assign(goal, data);
        return goal;
      },
    },
    bot: {
      findUnique: async ({
        where,
        include,
        select,
      }: {
        where: { id: string };
        include?: { thread?: boolean };
        select?: Record<string, true>;
      }) => {
        const bot = bots.find((b) => b.id === where.id);
        if (!bot) return null;
        if (select) return applySelect(bot, select);
        if (include?.thread) {
          return { ...bot, thread: threads.find((t) => t.botId === bot.id) ?? null };
        }
        return bot;
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
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const thread = threads.find((t) => t.id === where.id);
        if (!thread) throw new Error("thread not found");
        Object.assign(thread, applyIncrements(thread, data));
        return thread;
      },
    },
    task: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { status: "queued", ...data, id: nextId("task") };
        tasks.push(row);
        return row;
      },
    },
    run: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { status: "queued", ...data, id: nextId("run") };
        runs.push(row);
        return row;
      },
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        runs.find((r) => matches(r, where)) ?? null,
    },
    message: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { createdAt: new Date(), ...data, id: nextId("message") };
        messages.push(row);
        return row;
      },
      findMany: async ({ where }: { where?: Record<string, unknown> }) =>
        messages.filter((m) => matches(m, where)),
    },
    event: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { createdAt: new Date(), ...data, id: nextId("event") };
        events.push(row);
        return row;
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(client),
  };

  return {
    prisma: client as unknown as PrismaClient,
    goals,
    goalTasks,
    goalProposals,
    bots,
    threads,
    tasks,
    runs,
    messages,
    events,
  };
}

const BOT_ID = "bot-1";
const SPACE_ID = "space-1";
const USER_ID = "user-1";

type Fixture = ReturnType<typeof createFixture>;

function seedMuse(fixture: Fixture, overrides: Record<string, unknown> = {}) {
  fixture.bots.push({ id: BOT_ID, museProactivity: null, museQuietHours: null, ...overrides });
  const conversation = {
    id: "thread-conversation",
    spaceId: SPACE_ID,
    userId: USER_ID,
    botId: BOT_ID,
    groupId: null,
    goalId: null,
    nextMessageSeq: 0,
    nextEventSeq: 0,
    unread: false,
  };
  fixture.threads.push(conversation);
  return conversation;
}

function seedGoal(fixture: Fixture, overrides: Record<string, unknown> = {}) {
  const goal = {
    id: nextGoalId(),
    spaceId: SPACE_ID,
    userId: USER_ID,
    botId: BOT_ID,
    title: "Learn Japanese",
    description: "",
    status: "active",
    due: null,
    checkInCrons: [] as string[],
    timezone: "UTC",
    lastWorkedAt: null,
    nextWorkAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
  fixture.goals.push(goal);
  return goal;
}

let goalSeq = 0;
function nextGoalId() {
  goalSeq += 1;
  return `goal-${goalSeq}`;
}

function seedGoalLog(fixture: Fixture, goalId: string) {
  const log = {
    id: `${goalId}-log`,
    spaceId: SPACE_ID,
    userId: USER_ID,
    botId: null,
    groupId: null,
    goalId,
    nextMessageSeq: 0,
    nextEventSeq: 0,
    unread: false,
  };
  fixture.threads.push(log);
  return log;
}

function deps(
  fixture: Fixture,
  continueRun: (runId: string, workerId: string) => Promise<void> = vi.fn(async () => undefined),
) {
  const jobs = {
    enqueue: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  const events = { notify: vi.fn(async () => undefined) };
  return {
    prisma: fixture.prisma,
    jobs,
    events,
    continueRun,
    workerId: "worker-1",
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z")); // noon UTC: outside the default 22:00-08:00 quiet hours
});

afterEach(() => {
  vi.useRealTimers();
});

describe("goal.advance: skip rules", () => {
  it("does nothing for a Goal that is not active", async () => {
    const fixture = createFixture();
    seedMuse(fixture);
    const goal = seedGoal(fixture, { status: "paused" });
    const d = deps(fixture);
    const handlers = createGoalJobHandlers(d);

    await handlers["goal.advance"]({ goalId: goal.id });

    expect(d.jobs.enqueue).not.toHaveBeenCalled();
    expect(fixture.runs).toHaveLength(0);
    expect(d.continueRun).not.toHaveBeenCalled();
  });

  it("does nothing when proactivity is off", async () => {
    const fixture = createFixture();
    seedMuse(fixture, { museProactivity: "off" });
    const goal = seedGoal(fixture);
    const d = deps(fixture);
    const handlers = createGoalJobHandlers(d);

    await handlers["goal.advance"]({ goalId: goal.id });

    expect(d.jobs.enqueue).not.toHaveBeenCalled();
    expect(fixture.runs).toHaveLength(0);
  });

  it("does nothing for a Goal whose Muse no longer exists", async () => {
    const fixture = createFixture();
    const goal = seedGoal(fixture);
    const d = deps(fixture);
    const handlers = createGoalJobHandlers(d);

    await handlers["goal.advance"]({ goalId: goal.id });

    expect(d.jobs.enqueue).not.toHaveBeenCalled();
  });
});

describe("goal.advance: quiet hours", () => {
  it("reschedules to the end of quiet hours instead of working", async () => {
    vi.setSystemTime(new Date("2026-01-01T23:00:00.000Z")); // 23:00 UTC, inside 22:00-08:00
    const fixture = createFixture();
    seedMuse(fixture);
    const goal = seedGoal(fixture);
    const d = deps(fixture);
    const handlers = createGoalJobHandlers(d);

    await handlers["goal.advance"]({ goalId: goal.id });

    expect(fixture.runs).toHaveLength(0);
    expect(d.continueRun).not.toHaveBeenCalled();
    const expectedEnd = quietHoursEnd("22:00-08:00", new Date("2026-01-01T23:00:00.000Z"), "UTC")!;
    expect(d.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "goal.advance",
        payload: { goalId: goal.id },
        availableAt: expectedEnd,
        queueName: museQueueName(BOT_ID),
      }),
    );
  });
});

describe("goal.advance: the Conversation goes first", () => {
  it("reschedules +60s when the Conversation has an active run", async () => {
    const fixture = createFixture();
    const conversation = seedMuse(fixture);
    const goal = seedGoal(fixture);
    seedGoalLog(fixture, goal.id);
    fixture.runs.push({
      id: "run-conversation",
      threadId: conversation.id,
      status: "running",
    });
    const d = deps(fixture);
    const handlers = createGoalJobHandlers(d);

    await handlers["goal.advance"]({ goalId: goal.id });

    // No second run was started for the Goal itself.
    expect(fixture.runs).toHaveLength(1);
    expect(d.continueRun).not.toHaveBeenCalled();
    expect(d.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "goal.advance",
        payload: { goalId: goal.id },
        availableAt: new Date("2026-01-01T12:01:00.000Z"),
      }),
    );
  });
});

describe("goal.advance: doing the work", () => {
  it("creates a run in the Goal log, posts the report, sets lastWorkedAt, and schedules the next advance", async () => {
    const fixture = createFixture();
    seedMuse(fixture);
    const goal = seedGoal(fixture);
    const log = seedGoalLog(fixture, goal.id);

    const continueRun = vi.fn(async (runId: string) => {
      fixture.messages.push({
        id: "report-message",
        runId,
        role: "bot",
        blocks: [{ kind: "text", text: "Booked the trial lesson. Next: pick a textbook." }],
      });
    });
    const d = deps(fixture, continueRun);
    const handlers = createGoalJobHandlers(d);

    await handlers["goal.advance"]({ goalId: goal.id });

    // A run was started in the Goal's own log thread, not the Conversation.
    expect(fixture.runs).toHaveLength(1);
    expect(fixture.runs[0]).toMatchObject({ threadId: log.id, trigger: "goal_advance" });
    expect(fixture.tasks[0]).toMatchObject({ threadId: log.id });
    expect(continueRun).toHaveBeenCalledWith(fixture.runs[0]!.id, "worker-1");

    // The short report landed in the Conversation, not the Goal log.
    const conversationMessages = fixture.messages.filter(
      (m) => m.threadId === "thread-conversation",
    );
    expect(conversationMessages).toHaveLength(1);
    expect(conversationMessages[0]).toMatchObject({
      role: "bot",
      blocks: [{ kind: "text", text: "Booked the trial lesson. Next: pick a textbook." }],
    });
    expect(d.events.notify).toHaveBeenCalled();

    // lastWorkedAt is set and the next advance is scheduled by proactivity (normal = 1h).
    expect(fixture.goals[0]!.lastWorkedAt).toEqual(new Date("2026-01-01T12:00:00.000Z"));
    expect(d.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "goal.advance",
        payload: { goalId: goal.id },
        availableAt: new Date("2026-01-01T13:00:00.000Z"),
      }),
    );
  });

  it("creates the Goal log thread when it is missing", async () => {
    const fixture = createFixture();
    seedMuse(fixture);
    const goal = seedGoal(fixture);
    // No seedGoalLog call: the Goal has no log thread yet.
    const d = deps(fixture);
    const handlers = createGoalJobHandlers(d);

    await handlers["goal.advance"]({ goalId: goal.id });

    const created = fixture.threads.find((t) => t.goalId === goal.id);
    expect(created).toBeDefined();
    expect(fixture.runs[0]).toMatchObject({ threadId: created!.id });
  });

  it("does not post a report when the run produced no text", async () => {
    const fixture = createFixture();
    seedMuse(fixture);
    const goal = seedGoal(fixture);
    seedGoalLog(fixture, goal.id);
    const d = deps(fixture); // continueRun writes nothing
    const handlers = createGoalJobHandlers(d);

    await handlers["goal.advance"]({ goalId: goal.id });

    const conversationMessages = fixture.messages.filter(
      (m) => m.threadId === "thread-conversation",
    );
    expect(conversationMessages).toHaveLength(0);
    // Still counts as worked: lastWorkedAt and the next advance are still set.
    expect(fixture.goals[0]!.lastWorkedAt).toEqual(new Date("2026-01-01T12:00:00.000Z"));
    expect(d.jobs.enqueue).toHaveBeenCalledWith(expect.objectContaining({ name: "goal.advance" }));
  });
});

describe("goal.checkin", () => {
  it("reschedules +60s when the Conversation has an active run, without also re-deriving the next cron occurrence", async () => {
    const fixture = createFixture();
    const conversation = seedMuse(fixture);
    const goal = seedGoal(fixture, { checkInCrons: ["0 8 * * *"] });
    fixture.runs.push({ id: "run-conversation", threadId: conversation.id, status: "running" });
    const d = deps(fixture);
    const handlers = createGoalJobHandlers(d);

    await handlers["goal.checkin"]({ goalId: goal.id });

    expect(d.continueRun).not.toHaveBeenCalled();
    expect(d.jobs.enqueue).toHaveBeenCalledTimes(1);
    expect(d.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "goal.checkin",
        payload: { goalId: goal.id },
        availableAt: new Date("2026-01-01T12:01:00.000Z"),
      }),
    );
  });

  it("runs directly in the Conversation with the Routine trigger and schedules the next occurrence", async () => {
    const fixture = createFixture();
    seedMuse(fixture);
    const goal = seedGoal(fixture, { checkInCrons: ["0 8 * * *"], title: "Learn Japanese" });
    const d = deps(fixture);
    const handlers = createGoalJobHandlers(d);

    await handlers["goal.checkin"]({ goalId: goal.id });

    expect(fixture.runs).toHaveLength(1);
    expect(fixture.runs[0]).toMatchObject({
      threadId: "thread-conversation",
      trigger: "routine",
    });
    expect(fixture.tasks[0]!.prompt as string).toContain("Learn Japanese");
    expect(d.continueRun).toHaveBeenCalledWith(fixture.runs[0]!.id, "worker-1");

    const expectedNext = nextCronDateAcross(
      ["0 8 * * *"],
      new Date("2026-01-01T12:00:00.000Z"),
      "UTC",
    );
    expect(d.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "goal.checkin",
        payload: { goalId: goal.id },
        availableAt: expectedNext,
      }),
    );
  });

  it("still schedules the next occurrence for a paused Goal, but does not run it", async () => {
    const fixture = createFixture();
    seedMuse(fixture);
    const goal = seedGoal(fixture, { checkInCrons: ["0 8 * * *"], status: "paused" });
    const d = deps(fixture);
    const handlers = createGoalJobHandlers(d);

    await handlers["goal.checkin"]({ goalId: goal.id });

    expect(fixture.runs).toHaveLength(0);
    expect(d.continueRun).not.toHaveBeenCalled();
    expect(d.jobs.enqueue).toHaveBeenCalledWith(expect.objectContaining({ name: "goal.checkin" }));
  });
});

describe("wakeGoal", () => {
  it("enqueues goal.advance right away", async () => {
    const fixture = createFixture();
    seedMuse(fixture);
    const goal = seedGoal(fixture);
    const jobs = { enqueue: vi.fn(async () => undefined), cancel: vi.fn(), close: vi.fn() };

    await wakeGoal({ prisma: fixture.prisma, jobs: jobs as never }, goal.id);

    expect(jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "goal.advance",
        payload: { goalId: goal.id },
        queueName: museQueueName(BOT_ID),
      }),
    );
  });

  it("does nothing for a Goal that no longer exists", async () => {
    const fixture = createFixture();
    const jobs = { enqueue: vi.fn(async () => undefined), cancel: vi.fn(), close: vi.fn() };

    await wakeGoal({ prisma: fixture.prisma, jobs: jobs as never }, "missing");

    expect(jobs.enqueue).not.toHaveBeenCalled();
  });
});

describe("rescheduleMuseGoalsForBot", () => {
  it("re-derives every active Goal's advance from the Muse's current settings", async () => {
    const fixture = createFixture();
    seedMuse(fixture, { museProactivity: "high" });
    const a = seedGoal(fixture, { lastWorkedAt: new Date("2026-01-01T11:00:00.000Z") });
    const b = seedGoal(fixture, { status: "paused" }); // inactive: left alone
    const jobs = {
      enqueue: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
      close: vi.fn(),
    };

    await rescheduleMuseGoalsForBot({ prisma: fixture.prisma, jobs: jobs as never }, BOT_ID);

    // nextWorkAt is max(lastWorkedAt + interval, now); "now" (noon) is later than
    // 11:00 + 20m here, so it wins.
    expect(jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "goal.advance",
        payload: { goalId: a.id },
        availableAt: new Date("2026-01-01T12:00:00.000Z"),
      }),
    );
    expect(jobs.enqueue).not.toHaveBeenCalledWith(
      expect.objectContaining({ payload: { goalId: b.id } }),
    );
  });

  it("cancels every active Goal's pending advance when proactivity turns off", async () => {
    const fixture = createFixture();
    seedMuse(fixture, { museProactivity: "off" });
    const goal = seedGoal(fixture);
    const jobs = {
      enqueue: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
      close: vi.fn(),
    };

    await rescheduleMuseGoalsForBot({ prisma: fixture.prisma, jobs: jobs as never }, BOT_ID);

    expect(jobs.cancel).toHaveBeenCalledWith(`goal.advance:${goal.id}`);
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });
});

describe("scheduleGoalAdvance / scheduleGoalCheckin", () => {
  it("share one queueName per Muse (one Goal worked at a time)", async () => {
    const jobs = {
      enqueue: vi.fn(async (_job: BackgroundJob) => undefined),
      cancel: vi.fn(async () => undefined),
      close: vi.fn(),
    };
    await scheduleGoalAdvance(
      jobs as never,
      "goal-1",
      BOT_ID,
      new Date("2026-01-01T13:00:00.000Z"),
    );
    await scheduleGoalCheckin(
      jobs as never,
      { id: "goal-1", botId: BOT_ID, checkInCrons: ["0 8 * * *"], timezone: "UTC" },
      new Date("2026-01-01T12:00:00.000Z"),
    );
    for (const call of jobs.enqueue.mock.calls) {
      expect((call[0] as { queueName?: string }).queueName).toBe(museQueueName(BOT_ID));
    }
  });

  it("cancels the pending check-in when a Goal has no crons left", async () => {
    const jobs = {
      enqueue: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
      close: vi.fn(),
    };
    const next = await scheduleGoalCheckin(
      jobs as never,
      { id: "goal-1", botId: BOT_ID, checkInCrons: [], timezone: "UTC" },
      new Date("2026-01-01T12:00:00.000Z"),
    );
    expect(next).toBeNull();
    expect(jobs.cancel).toHaveBeenCalledWith("goal.checkin:goal-1");
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });
});
