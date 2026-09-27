import type { MuseState, Run, ThreadMessage } from "@aiden/contracts";
import { useAsks } from "../asks";
import { currentToolName, deriveMuseState, museActivityLabel } from "./museState";

export type MuseLiveRun = Pick<Run, "id" | "status">;

export interface MuseLiveState {
  state: MuseState;
  /** `undefined` while idle — every surface shows nothing rather than a caption. */
  label: string | undefined;
  askCount: number;
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
  const { count: askCount } = useAsks(botId);
  const state = deriveMuseState(runs, askCount);
  const activeRun = activeRunFor(runs);
  const activityMessage = activeRun
    ? messages?.find((message) => message.id === `progress:${activeRun.id}`)
    : undefined;
  const label = museActivityLabel(state, currentToolName(activityMessage?.blocks));
  return { state, label, askCount };
}
