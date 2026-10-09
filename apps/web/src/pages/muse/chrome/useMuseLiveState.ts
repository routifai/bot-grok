import { useLingui } from "@lingui/react/macro";
import type { MuseState, Run, ThreadMessage } from "@nova/contracts";
import { useAsks } from "../../../features/approvals";
import { useComputerLaunch } from "../../../features/computer/useComputerLaunch";
import { currentToolName, deriveMuseState, museActivityLabel } from "./museState";

/** A run as the Muse surfaces see it. `startedAt`/`createdAt` is when it really began, so every
 * surface (the working row, a remounted pane) counts elapsed time from the run, not from mount. */
export type MuseLiveRun = Pick<Run, "id" | "status"> &
  Partial<Pick<Run, "startedAt" | "createdAt">> & {
    /** Epoch ms the run began, when the caller knows it better than the run's timestamps. */
    startedAtMs?: number;
  };

export interface MuseLiveState {
  state: MuseState;
  /** `undefined` while idle — every surface shows nothing rather than a caption. */
  label: string | undefined;
  askCount: number;
  /** Epoch ms the active run began; `undefined` while idle or when unknown. */
  runStartedAt: number | undefined;
}

export function runStartMs(run: MuseLiveRun | undefined): number | undefined {
  if (!run) return undefined;
  if (run.startedAtMs !== undefined) return run.startedAtMs;
  for (const stamp of [run.startedAt, run.createdAt]) {
    const ms = stamp ? Date.parse(stamp) : Number.NaN;
    if (Number.isFinite(ms)) return ms;
  }
  return undefined;
}

function activeRunFor(runs: readonly MuseLiveRun[]): MuseLiveRun | undefined {
  return (
    runs.find((run) => run.status === "running") ??
    runs.find((run) => run.status === "waiting_input" || run.status === "waiting_takeover")
  );
}

/**
 * Standalone derivation of the live Muse state (docs/muse/DESIGN.md), self-sufficient
 * beyond the live run/message data every muse-mode surface already has: the sidebar's
 * top card, the Conversation header's live label, the transcript's gutter face, and
 * its bottom-of-transcript "thinking/working" row all call this directly instead of
 * threading a precomputed state through Shell's already-large prop lists.
 */
export function useMuseLiveState({
  botId,
  runs,
  messages,
}: {
  botId: string;
  runs: readonly MuseLiveRun[];
  messages: readonly ThreadMessage[] | undefined;
}): MuseLiveState {
  const { t } = useLingui();
  const { count: askCount } = useAsks(botId);
  const state = deriveMuseState(runs, askCount);
  const busy = state === "thinking" || state === "working";
  const launch = useComputerLaunch(botId, busy);
  const activeRun = activeRunFor(runs);
  const activityMessage = activeRun
    ? messages?.find((message) => message.id === `progress:${activeRun.id}`)
    : undefined;
  // While the Computer is starting nothing else is happening, so say that instead of "Thinking…".
  const starting = busy && launch !== undefined && launch.stage !== "failed";
  const label = starting
    ? t`Starting your Computer…`
    : museActivityLabel(state, currentToolName(activityMessage?.blocks));
  return { state, label, askCount, runStartedAt: runStartMs(activeRun) };
}
