import type { Activity } from "@aiden/contracts";
import { expect, it } from "vitest";
import {
  ACTIVITY_POLL_ACTIVE_MS,
  ACTIVITY_POLL_IDLE_MS,
  activitiesPollIntervalMs,
  activityDateLabel,
  activityLineText,
  activityStatusMark,
  groupActivitiesByDate,
  isHelperActivity,
} from "./activityGrouping";

function activity(overrides: Partial<Activity> = {}): Activity {
  return {
    id: "act-1",
    kind: "turn",
    chatId: "chat-1",
    title: "Checked the budget totals",
    outcome: "Everything ties out.",
    status: "done",
    startedAt: "2026-10-03T11:21:00.000Z",
    finishedAt: "2026-10-03T11:22:00.000Z",
    date: "2026-10-03",
    ...overrides,
  };
}

const LABELS = {
  in_progress: "Working",
  done: "Done",
  failed: "Didn't finish",
  cancelled: "Cancelled",
};

it("polls briskly while anything is in progress, and relaxed once everything has settled", () => {
  expect(activitiesPollIntervalMs([])).toBe(ACTIVITY_POLL_IDLE_MS);
  expect(activitiesPollIntervalMs([activity({ status: "done" })])).toBe(ACTIVITY_POLL_IDLE_MS);
  expect(
    activitiesPollIntervalMs([activity({ status: "done" }), activity({ status: "in_progress" })]),
  ).toBe(ACTIVITY_POLL_ACTIVE_MS);
});

it("marks a Helper's whole task as kind sub_agent, and a plain turn as not one", () => {
  expect(isHelperActivity(activity({ kind: "sub_agent" }))).toBe(true);
  expect(isHelperActivity(activity({ kind: "turn" }))).toBe(false);
});

it("maps every status to its own mark", () => {
  expect(activityStatusMark("in_progress")).toBe("live");
  expect(activityStatusMark("done")).toBe("done");
  expect(activityStatusMark("failed")).toBe("failed");
  expect(activityStatusMark("cancelled")).toBe("muted");
});

it("shows the outcome when there is one, even while in progress (the engine's current step)", () => {
  expect(
    activityLineText({ status: "in_progress", outcome: "Comparing line 61 of 84" }, LABELS),
  ).toBe("Comparing line 61 of 84");
  expect(activityLineText({ status: "done", outcome: "Ties out." }, LABELS)).toBe("Ties out.");
});

it("falls back to a plain status word when there is no outcome yet", () => {
  expect(activityLineText({ status: "in_progress", outcome: null }, LABELS)).toBe("Working");
  expect(activityLineText({ status: "failed", outcome: null }, LABELS)).toBe("Didn't finish");
  expect(activityLineText({ status: "cancelled", outcome: null }, LABELS)).toBe("Cancelled");
});

it("labels today and yesterday, and a weekday+date for anything older", () => {
  const now = new Date("2026-10-03T15:00:00.000Z");
  expect(activityDateLabel("2026-10-03", now)).toEqual({ kind: "today" });
  expect(activityDateLabel("2026-10-02", now)).toEqual({ kind: "yesterday" });
  const older = activityDateLabel("2026-09-28", now, "en");
  expect(older.kind).toBe("weekday");
  if (older.kind === "weekday") {
    expect(older.text).toContain("Sep");
    expect(older.text).toContain("28");
  }
});

it("groups a newest-first list by day, keeping order, without re-sorting", () => {
  const now = new Date("2026-10-03T15:00:00.000Z");
  const activities = [
    activity({ id: "a1", date: "2026-10-03" }),
    activity({ id: "a2", date: "2026-10-03" }),
    activity({ id: "a3", date: "2026-10-02" }),
    activity({ id: "a4", date: "2026-09-20" }),
  ];
  const groups = groupActivitiesByDate(activities, now);
  expect(groups).toHaveLength(3);
  expect(groups[0]?.label).toEqual({ kind: "today" });
  expect(groups[0]?.activities.map((a) => a.id)).toEqual(["a1", "a2"]);
  expect(groups[1]?.label).toEqual({ kind: "yesterday" });
  expect(groups[1]?.activities.map((a) => a.id)).toEqual(["a3"]);
  expect(groups[2]?.label.kind).toBe("weekday");
  expect(groups[2]?.activities.map((a) => a.id)).toEqual(["a4"]);
});

it("returns nothing for an empty list", () => {
  expect(groupActivitiesByDate([], new Date())).toEqual([]);
});
