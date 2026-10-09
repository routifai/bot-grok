import type { ThreadMessage } from "@nova/contracts";
import { useMemo } from "react";
import { type MuseLiveRun, useMuseLiveState } from "../../pages/muse/chrome/useMuseLiveState";
import { deriveNovaWork, type NovaWork } from "./novaWork";
import { useActivities } from "./useActivities";

/** Nova's live work (novaWork.ts) from the shell's runs and the shared Activity feed. */
export function useNovaWork({
  botId,
  runs,
  messages,
}: {
  botId: string;
  runs: readonly MuseLiveRun[];
  messages: readonly ThreadMessage[] | undefined;
}): NovaWork {
  const { state } = useMuseLiveState({ botId, runs, messages });
  const { state: feed } = useActivities(botId);
  const activities = feed.status === "ready" ? feed.activities : undefined;
  return useMemo(() => deriveNovaWork(state, activities ?? []), [state, activities]);
}
