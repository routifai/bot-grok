import { useLingui } from "@lingui/react/macro";
import { useMemo } from "react";
import { SuperchatOrb } from "../../components/ai/orb";
import { useNow } from "../../components/chrome/useNow";
import { serverNow, workingSince } from "./superchatWork";
import { useActivities } from "./useActivities";
import { formatClock } from "./workStripState";

/**
 * The lit state in the conversation header (ADR 0023): while the turn or any Helper runs, the orb
 * and "Working · 0:12" in a pill whose edge carries a turning glow, so running work shows even
 * when the strip under its reply is scrolled away. Nothing while everything has settled.
 */
export function WorkingPill({
  botId,
  turnStartedAt,
}: {
  botId: string;
  /** When the running turn began (ms, the engine's clock: workPlan.ts `runningSince`, which its
   * strip counts from too); null while no turn runs. */
  turnStartedAt: number | null;
}) {
  const { t } = useLingui();
  const { state } = useActivities(botId);
  const activities = state.status === "ready" ? state.activities : undefined;
  const since = useMemo(
    () => workingSince(turnStartedAt, activities ?? []),
    [turnStartedAt, activities],
  );
  const now = useNow(since !== null);
  if (since === null) return null;
  return (
    <span
      data-testid="working-pill"
      className="relative flex animate-in items-center gap-2 rounded-full border border-separator bg-glass py-1 ps-[5px] pe-[11px] text-[12.5px] text-foreground tabular-nums fade-in slide-in-from-top-1 duration-400 motion-reduce:animate-none"
    >
      <span aria-hidden="true" className="sc-live-ring" />
      <SuperchatOrb size={16} state="working" flies={false} />
      <span>
        {t`Working`} · {formatClock(Math.max(0, serverNow(now) - since))}
      </span>
    </span>
  );
}
