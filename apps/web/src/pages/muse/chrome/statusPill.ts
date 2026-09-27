/**
 * Pure derivation of the Conversation header's `StatusPill` (docs/muse/DESIGN.md
 * "Status"): "Nova is on 2 things · last check 4m ago", `live` while a run is
 * active, `attention` when an Ask is open, otherwise a plain "Idle".
 */

export type StatusPillTone = "neutral" | "live" | "attention";

export interface StatusPillGoal {
  status: "active" | "paused" | "done" | "cancelled";
  lastWorkedAt: string | null;
}

export interface StatusPillInput {
  museName: string;
  /** Every Goal the Muse has (any status); only active ones with recent work count. */
  goals: readonly StatusPillGoal[];
  /** Whether a run is currently active on the Conversation or a Goal. */
  running: boolean;
  /** Open Asks always win: an Ask waits on the person regardless of what else runs. */
  openAskCount: number;
  now?: number;
  /** How far back "worked on recently" looks. Defaults to 24h. */
  recentWindowMs?: number;
}

export interface StatusPillResult {
  tone: StatusPillTone;
  text: string;
}

const DEFAULT_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

function minutesAgo(fromMs: number, nowMs: number): number {
  return Math.max(0, Math.round((nowMs - fromMs) / 60_000));
}

export function deriveStatusPill({
  museName,
  goals,
  running,
  openAskCount,
  now = Date.now(),
  recentWindowMs = DEFAULT_RECENT_WINDOW_MS,
}: StatusPillInput): StatusPillResult {
  if (openAskCount > 0) {
    return { tone: "attention", text: `${museName} is waiting on you` };
  }

  const recentGoals = goals.filter(
    (goal) =>
      goal.status === "active" &&
      goal.lastWorkedAt != null &&
      now - new Date(goal.lastWorkedAt).getTime() <= recentWindowMs,
  );
  // A running turn always counts as one of the "things" the Muse is on, even
  // when it isn't yet reflected in a Goal's lastWorkedAt (e.g. a fresh run).
  const thingsCount = recentGoals.length + (running ? 1 : 0);
  const tone: StatusPillTone = running ? "live" : "neutral";

  if (thingsCount === 0) {
    return { tone, text: `${museName} is idle` };
  }

  const mostRecentMs = recentGoals.reduce<number | null>((latest, goal) => {
    const workedAtMs = new Date(goal.lastWorkedAt as string).getTime();
    return latest === null || workedAtMs > latest ? workedAtMs : latest;
  }, null);
  const lastCheckMinutes = mostRecentMs === null ? 0 : minutesAgo(mostRecentMs, now);
  const lastCheckLabel = lastCheckMinutes === 0 ? "just now" : `${lastCheckMinutes}m ago`;

  return {
    tone,
    text: `${museName} is on ${thingsCount} thing${thingsCount === 1 ? "" : "s"} · last check ${lastCheckLabel}`,
  };
}
