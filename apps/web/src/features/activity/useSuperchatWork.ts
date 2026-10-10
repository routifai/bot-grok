import type { ThreadMessage } from "@superchat/contracts";
import { useMemo } from "react";
import { type MuseLiveRun, useMuseLiveState } from "../../pages/muse/chrome/useMuseLiveState";
import { deriveSuperchatWork, type SuperchatWork } from "./superchatWork";
import { useActivities } from "./useActivities";

/** Superchat's live work (superchatWork.ts) from the shell's runs and the shared Activity feed. */
export function useSuperchatWork({
  botId,
  runs,
  messages,
}: {
  botId: string;
  runs: readonly MuseLiveRun[];
  messages: readonly ThreadMessage[] | undefined;
}): SuperchatWork {
  const { state } = useMuseLiveState({ botId, runs, messages });
  const { state: feed } = useActivities(botId);
  const activities = feed.status === "ready" ? feed.activities : undefined;
  return useMemo(() => deriveSuperchatWork(state, activities ?? []), [state, activities]);
}
