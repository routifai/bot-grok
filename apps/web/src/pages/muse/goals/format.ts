import type { Goal, GoalTask } from "@aiden/contracts";
import { formatCron } from "@aiden/core";

/** Formats a Goal's due date ("YYYY-MM-DD") in the given locale, or null when unset. */
export function formatDueDate(due: string | null, locale: string): string | null {
  if (!due) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(due);
  if (!match) return due;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  return date.toLocaleDateString(locale || "en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** The first Task in plan order that isn't done or skipped, or null when the plan is clear. */
export function nextUnfinishedTask(goal: Pick<Goal, "tasks">): GoalTask | null {
  const ordered = [...goal.tasks].sort((a, b) => a.idx - b.idx);
  return ordered.find((task) => task.status !== "done" && task.status !== "skipped") ?? null;
}

/** Done / total Task counts for a Goal's Progress meter. */
export function taskCounts(goal: Pick<Goal, "tasks">): { done: number; total: number } {
  const total = goal.tasks.length;
  const done = goal.tasks.filter((task) => task.status === "done").length;
  return { done, total };
}

/**
 * A Goal's due date, either as a near-term absolute date ("Due Dec 10") or, once it's far
 * enough out, a softer relative distance ("in 10 weeks") — see docs/muse/DESIGN.md "Goals".
 */
export type DueMeta = { kind: "absolute"; date: string } | { kind: "relative"; weeks: number };

const NEAR_TERM_DAYS = 84; // ~12 weeks

export function dueMeta(
  due: string | null,
  locale: string,
  now: Date = new Date(),
): DueMeta | null {
  if (!due) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(due);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.round((date.getTime() - today.getTime()) / 86_400_000);
  if (diffDays <= NEAR_TERM_DAYS) {
    return { kind: "absolute", date: formatDueDate(due, locale) ?? due };
  }
  return { kind: "relative", weeks: Math.max(1, Math.round(diffDays / 7)) };
}

/** A Goal's check-in schedule as one compact line, or null when there are no check-ins. */
export function checkInSummary(crons: string[]): string | null {
  if (crons.length === 0) return null;
  return crons.map(formatCron).join(" · ");
}

/**
 * The Goal's state as shown by its `StatusPill` (docs/muse/DESIGN.md "Goals"): waiting on
 * you (an open Proposal or a blocked Task), working (the Muse touched it in the last hour),
 * paused, or quietly on track.
 */
export type GoalDisplayStatus = "waiting" | "working" | "paused" | "noPlan" | "onTrack";

const WORKING_WINDOW_MS = 60 * 60 * 1000;

export function goalDisplayStatus(
  goal: Pick<Goal, "status" | "openProposal" | "tasks" | "lastWorkedAt">,
  now: number = Date.now(),
): GoalDisplayStatus {
  if (goal.status === "paused") return "paused";
  const hasBlockedTask = goal.tasks.some((task) => task.status === "blocked");
  if (goal.openProposal || hasBlockedTask) return "waiting";
  if (goal.tasks.length === 0) return "noPlan";
  if (goal.lastWorkedAt && now - Date.parse(goal.lastWorkedAt) <= WORKING_WINDOW_MS)
    return "working";
  return "onTrack";
}

/** Counts behind the Goals list subtitle, e.g. "2 active · 1 waiting on you". */
export function goalsSummary(goals: Goal[]): { active: number; waiting: number } {
  const active = goals.filter((goal) => goal.status === "active");
  const waiting = active.filter((goal) => goalDisplayStatus(goal) === "waiting").length;
  return { active: active.length, waiting };
}

/** A compact, mono-styled timestamp for a Goal log entry. */
export function formatLogTimestamp(iso: string, locale: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(locale || "en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
