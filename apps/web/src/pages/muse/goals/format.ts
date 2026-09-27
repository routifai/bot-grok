import type { Goal, GoalTask } from "@rakazo/contracts";

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
