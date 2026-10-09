import type { Activity, MuseState } from "@nova/contracts";
import type { OrbState } from "../../components/ai/orb/orbState";
import { orbStateFor } from "../../components/ai/orb/orbState";
import { buildActivityForest, isNodeRunning } from "./activityTree";

export type NovaWork = {
  /** Every orb's state: working while a turn runs or any Activity is in progress. */
  orb: OrbState;
  /** How many things Nova is working on, for the sidebar's status line; 0 when ready. */
  count: number;
};

/** Nova's live work from the run state and the Activity feed: running top-level Activities,
 * or one for a turn that has not reached the feed yet. */
export function deriveNovaWork(state: MuseState, activities: readonly Activity[]): NovaWork {
  const running = buildActivityForest(activities).filter(isNodeRunning).length;
  const busy = orbStateFor(state) === "working";
  const count = Math.max(running, busy ? 1 : 0);
  return { orb: count > 0 ? "working" : "idle", count };
}
