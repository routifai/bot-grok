import { describe, expect, it, vi } from "vitest";
import {
  dispatchBackgroundJob,
  goalAdvanceJob,
  goalAdvanceJobKey,
  goalCheckinJob,
  goalCheckinJobKey,
  HISTORY_COMPACT_MAX_ATTEMPTS,
  historyCompactJob,
  historyCompactJobKey,
  ideasRefreshJob,
  ideasRefreshJobKey,
  messagingDeliverJob,
  museQueueName,
  parseBackgroundJob,
} from "./background-jobs.js";
import type { BackgroundJobHandlers } from "./types.js";

function handlers(): BackgroundJobHandlers {
  return {
    "run.continue": vi.fn(async () => undefined),
    "routine.wakeup": vi.fn(async () => undefined),
    "computer.update": vi.fn(async () => undefined),
    "computer.sleep": vi.fn(async () => undefined),
    "computer.control-expire": vi.fn(async () => undefined),
    "skill.teaching-expire": vi.fn(async () => undefined),
    "history.compact": vi.fn(async () => undefined),
    "messaging.deliver": vi.fn(async () => undefined),
    "cloud_agent.poll": vi.fn(async () => undefined),
    "ideas.refresh": vi.fn(async () => undefined),
    "goal.advance": vi.fn(async () => undefined),
    "goal.checkin": vi.fn(async () => undefined),
  };
}

describe("background job contracts", () => {
  it("validates and dispatches messaging.deliver", async () => {
    const target = handlers();
    await dispatchBackgroundJob(target, "messaging.deliver", { runId: "run-1" });
    expect(target["messaging.deliver"]).toHaveBeenCalledWith({ runId: "run-1" });
    expect(messagingDeliverJob("run-1")).toEqual({
      name: "messaging.deliver",
      payload: { runId: "run-1" },
      replaceKey: "messaging.deliver:run-1",
    });
    expect(messagingDeliverJob()).toEqual({
      name: "messaging.deliver",
      payload: {},
      replaceKey: "messaging.deliver:drain",
    });
  });

  it("validates and dispatches a typed job", async () => {
    const target = handlers();
    await dispatchBackgroundJob(target, "routine.wakeup", {
      routineId: "routine-1",
      scheduledFor: "2026-08-15T12:00:00.000Z",
    });
    expect(target["routine.wakeup"]).toHaveBeenCalledWith({
      routineId: "routine-1",
      scheduledFor: "2026-08-15T12:00:00.000Z",
    });
  });

  it("rejects unknown names and malformed deliveries", () => {
    expect(() => parseBackgroundJob("unknown", {})).toThrow("Unknown background job");
    expect(() =>
      parseBackgroundJob("routine.wakeup", {
        routineId: "routine-1",
        scheduledFor: "not-a-date",
      }),
    ).toThrow();
    expect(() => parseBackgroundJob("run.continue", { runId: "" })).toThrow();
    expect(() =>
      parseBackgroundJob("computer.control-expire", {
        computerId: "computer-1",
        leaseId: "",
      }),
    ).toThrow();
  });

  it("validates and dispatches a control-expiry job", async () => {
    const target = handlers();
    await dispatchBackgroundJob(target, "computer.control-expire", {
      computerId: "computer-1",
      leaseId: "lease-1",
    });
    expect(target["computer.control-expire"]).toHaveBeenCalledWith({
      computerId: "computer-1",
      leaseId: "lease-1",
    });
  });
});

describe("historyCompactJob", () => {
  it("builds a job with a replace key scoped to the thread", () => {
    expect(historyCompactJob("thread-1")).toEqual({
      name: "history.compact",
      payload: { threadId: "thread-1" },
      replaceKey: historyCompactJobKey("thread-1"),
      maxAttempts: HISTORY_COMPACT_MAX_ATTEMPTS,
    });
  });

  it("caps attempts below the queue default so a stuck thread cannot storm", () => {
    expect(HISTORY_COMPACT_MAX_ATTEMPTS).toBeLessThan(25);
  });

  it("keys different threads differently", () => {
    expect(historyCompactJobKey("thread-1")).not.toBe(historyCompactJobKey("thread-2"));
  });
});

describe("ideasRefreshJob", () => {
  it("validates and dispatches with a replace key scoped to the bot", async () => {
    const target = handlers();
    await dispatchBackgroundJob(target, "ideas.refresh", { botId: "bot-1" });
    expect(target["ideas.refresh"]).toHaveBeenCalledWith({ botId: "bot-1" });
    expect(ideasRefreshJob("bot-1")).toEqual({
      name: "ideas.refresh",
      payload: { botId: "bot-1" },
      replaceKey: ideasRefreshJobKey("bot-1"),
    });
  });

  it("carries an availableAt when given one, for scheduling the next daily run", () => {
    const availableAt = new Date("2026-09-28T07:00:00.000Z");
    expect(ideasRefreshJob("bot-1", availableAt)).toEqual({
      name: "ideas.refresh",
      payload: { botId: "bot-1" },
      replaceKey: "ideas.refresh:bot-1",
      availableAt,
    });
  });

  it("keys different bots differently", () => {
    expect(ideasRefreshJobKey("bot-1")).not.toBe(ideasRefreshJobKey("bot-2"));
  });
});

describe("Muse Goal jobs (docs/muse/PLAN.md B8)", () => {
  it("shares one queueName per Muse so goal.advance and goal.checkin serialize", () => {
    expect(museQueueName("bot-1")).toBe("muse:bot-1");
    expect(goalAdvanceJob("goal-1", "bot-1").queueName).toBe(museQueueName("bot-1"));
    expect(goalCheckinJob("goal-1", "bot-1", new Date("2026-09-28T07:30:00.000Z")).queueName).toBe(
      museQueueName("bot-1"),
    );
  });

  it("builds a goal.advance job with a replace key scoped to the Goal", () => {
    expect(goalAdvanceJob("goal-1", "bot-1")).toEqual({
      name: "goal.advance",
      payload: { goalId: "goal-1" },
      replaceKey: goalAdvanceJobKey("goal-1"),
      queueName: "muse:bot-1",
    });
    const at = new Date("2026-09-28T07:30:00.000Z");
    expect(goalAdvanceJob("goal-1", "bot-1", at)).toEqual({
      name: "goal.advance",
      payload: { goalId: "goal-1" },
      replaceKey: goalAdvanceJobKey("goal-1"),
      queueName: "muse:bot-1",
      availableAt: at,
    });
  });

  it("builds a goal.checkin job scheduled for a specific time", () => {
    const at = new Date("2026-09-28T07:30:00.000Z");
    expect(goalCheckinJob("goal-1", "bot-1", at)).toEqual({
      name: "goal.checkin",
      payload: { goalId: "goal-1" },
      replaceKey: goalCheckinJobKey("goal-1"),
      queueName: "muse:bot-1",
      availableAt: at,
    });
  });

  it("validates and dispatches goal.advance / goal.checkin", async () => {
    const target = handlers();
    await dispatchBackgroundJob(target, "goal.advance", { goalId: "goal-1" });
    expect(target["goal.advance"]).toHaveBeenCalledWith({ goalId: "goal-1" });
    await dispatchBackgroundJob(target, "goal.checkin", { goalId: "goal-1" });
    expect(target["goal.checkin"]).toHaveBeenCalledWith({ goalId: "goal-1" });
    expect(() => parseBackgroundJob("goal.advance", { goalId: "" })).toThrow();
  });
});
