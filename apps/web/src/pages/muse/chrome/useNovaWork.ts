import type { ThreadMessage } from "@aiden/contracts";
import { useMemo } from "react";
import { deriveNovaWork, type NovaWork } from "./novaWork";
import { useActivities } from "./useActivities";
import { type MuseLiveRun, useMuseLiveState } from "./useMuseLiveState";

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
