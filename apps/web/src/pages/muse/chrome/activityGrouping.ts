import type { Activity, ActivityStatus } from "@aiden/contracts";

// Pure helpers for the Activity panel (docs/super-chat/README.md "The Activity panel";
// docs/super-chat/WIRING.md "Activity panel"): grouping by day, the status→mark mapping, the
// line shown under a title, and the polling cadence decision. Kept free of React/i18n so
// activityGrouping.test.ts can exercise every branch directly.

/** How often the panel polls `activities.list` while the tab is visible: briskly while
 * something is still running, relaxed once everything has settled. */
export const ACTIVITY_POLL_ACTIVE_MS = 5_000;
export const ACTIVITY_POLL_IDLE_MS = 20_000;

/** The polling cadence decision: 5s while any Activity is in progress, 20s otherwise. */
export function activitiesPollIntervalMs(activities: readonly Activity[]): number {
  return activities.some((activity) => activity.status === "in_progress")
    ? ACTIVITY_POLL_ACTIVE_MS
    : ACTIVITY_POLL_IDLE_MS;
}

/** A Helper's whole task (CONTEXT.md "Helper"; engine "sub_agent"), shown with a small
 * "Helper" label, as opposed to a plain Conversation/Side Chat turn ("turn"). */
export function isHelperActivity(activity: Pick<Activity, "kind">): boolean {
  return activity.kind === "sub_agent";
}

export type ActivityMark = "live" | "done" | "failed" | "muted";

const MARK_BY_STATUS: Record<ActivityStatus, ActivityMark> = {
  in_progress: "live",
  done: "done",
  failed: "failed",
  cancelled: "muted",
};

/** The status mark on an Activity's line: a breathing dot (in progress), a quiet check
 * (done), a destructive mark (failed), or a muted dash (cancelled). */
export function activityStatusMark(status: ActivityStatus): ActivityMark {
  return MARK_BY_STATUS[status];
}

/** The line shown under an Activity's title: its one-line outcome when there is one
 * (which the engine also uses to carry the current step while in progress), otherwise a
 * plain status word for the ones that never get one — never "null" or a blank line. */
export function activityLineText(
  activity: Pick<Activity, "status" | "outcome">,
  labels: Record<ActivityStatus, string>,
): string {
  return activity.outcome ?? labels[activity.status];
}

function dateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export type ActivityDateLabel =
  | { kind: "today" }
  | { kind: "yesterday" }
  | { kind: "weekday"; text: string };

/** A group's heading: "Today", "Yesterday", or a weekday + date for anything older
 * (README.md "grouped by day"). `now` is passed in so this stays pure and testable
 * without mocking the clock. */
export function activityDateLabel(date: string, now: Date, locale = "en"): ActivityDateLabel {
  const today = dateKey(now);
  const yesterday = dateKey(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  if (date === today) return { kind: "today" };
  if (date === yesterday) return { kind: "yesterday" };
  const parsed = new Date(`${date}T00:00:00`);
  const text = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(parsed);
  return { kind: "weekday", text };
}

export interface ActivityGroup {
  date: string;
  label: ActivityDateLabel;
  activities: Activity[];
}

/** Groups Activities — already newest-first from `activities.list` — by calendar day,
 * keeping that order. A day's Activities are always contiguous in a newest-first list,
 * so this never needs to re-sort, only to notice when `date` changes. */
export function groupActivitiesByDate(
  activities: readonly Activity[],
  now: Date,
  locale = "en",
): ActivityGroup[] {
  const groups: ActivityGroup[] = [];
  for (const activity of activities) {
    const last = groups.at(-1);
    if (last && last.date === activity.date) {
      last.activities.push(activity);
      continue;
    }
    groups.push({
      date: activity.date,
      label: activityDateLabel(activity.date, now, locale),
      activities: [activity],
    });
  }
  return groups;
}
