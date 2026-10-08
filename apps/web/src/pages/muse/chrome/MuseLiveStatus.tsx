import { useLingui } from "@lingui/react/macro";
import type { ThreadMessage } from "@nova/contracts";
import type { ReactNode } from "react";
import { Shimmer } from "../../../components/ai/primitives";
import { StatusPill } from "../ui";
import { deriveStatusPill } from "./statusPill";
import { type MuseLiveRun, useMuseLiveState } from "./useMuseLiveState";

/**
 * The live Nova indicator (docs/muse/DESIGN.md "Status"), the toolbar's subtitle: `fallback`
 * (or nothing) while idle, a shimmering verb while thinking/working ("Thinking…",
 * "Browsing…", "Running code…"), or a clickable "Needs you" pill while an Ask is open.
 */
export function MuseLiveStatus({
  botId,
  runs,
  messages,
  onOpenWaiting,
  fallback = null,
}: {
  botId: string;
  /** Kept for callers; the orb shows Nova now. */
  color?: string;
  runs: readonly MuseLiveRun[];
  messages: readonly ThreadMessage[] | undefined;
  onOpenWaiting?: () => void;
  /** What the subtitle says while Nova is idle. */
  fallback?: ReactNode;
}) {
  const { t } = useLingui();
  const { state, label } = useMuseLiveState({ botId, runs, messages });
  if (!label) return fallback ? <span className="truncate">{fallback}</span> : null;

  const pill = deriveStatusPill(state);
  if (pill) {
    return (
      <StatusPill tone={pill.tone} onClick={onOpenWaiting} label={t`Open what's waiting on you`}>
        {pill.text}
      </StatusPill>
    );
  }

  return (
    <span className="min-w-0 truncate">
      <Shimmer>{label}</Shimmer>
    </span>
  );
}
