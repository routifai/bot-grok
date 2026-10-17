import type { Activity, MuseState } from "@superchat/contracts";
import type { OrbState } from "../../components/ai/orb/orbState";
import { orbStateFor } from "../../components/ai/orb/orbState";
import { buildActivityForest, isNodeRunning } from "./activityTree";

export type SuperchatWork = {
  /** Every orb's state: working while a turn runs or any Activity is in progress. */
  orb: OrbState;
  /** How many things Superchat is working on, for the sidebar's status line; 0 when ready. */
  count: number;
};

/** Superchat's live work from the run state and the Activity feed: running top-level Activities,
 * or one for a turn that has not reached the feed yet. */
export function deriveSuperchatWork(
  state: MuseState,
  activities: readonly Activity[],
): SuperchatWork {
  const running = buildActivityForest(activities).filter(isNodeRunning).length;
  const busy = orbStateFor(state) === "working";
  const count = Math.max(running, busy ? 1 : 0);
  return { orb: count > 0 ? "working" : "idle", count };
}

/** When the work running now began (ms): the earliest of the turn's start and the running
 * Activities' starts; null when nothing runs (the header's "Working · 0:12" pill). */
export function workingSince(
  turnStartedAt: number | null,
  activities: readonly Activity[],
): number | null {
  const starts = buildActivityForest(activities)
    .filter(isNodeRunning)
    .map((node) => Date.parse(node.activity.startedAt))
    .filter((ms) => !Number.isNaN(ms));
  if (turnStartedAt !== null) starts.push(turnStartedAt);
  return starts.length > 0 ? Math.min(...starts) : null;
}
