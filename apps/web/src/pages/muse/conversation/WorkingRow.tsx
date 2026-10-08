import { useState } from "react";
import { Shimmer } from "../../../components/ai/primitives";
import { WorkingDot } from "../chrome/ActivityLine";
import { formatDuration } from "../chrome/activityGrouping";
import { useNow } from "../chrome/useNow";

/**
 * Nova working on a reply (docs/muse/DESIGN.md "Working line"): a soft rounded row with a
 * small pulsing dot, the current step ("Thinking…", "Browsing…") and how long it has gone.
 */
export function WorkingRow({ label }: { label: string }) {
  const [startedAt] = useState(() => Date.now());
  const now = useNow(true);
  return (
    <div data-testid="muse-live-row" aria-hidden="true" className="flex min-h-10 items-center">
      <span className="inline-flex items-center gap-2.5 rounded-xl bg-window py-1.5 ps-1.5 pe-3 text-[13px]">
        <span className="grid size-[22px] place-items-center">
          <WorkingDot />
        </span>
        <span className="text-ink-2">
          <Shimmer>{label}</Shimmer>
        </span>
        <span className="ms-1.5 font-mono text-[12px] text-ink-3 tabular-nums">
          {formatDuration(now - startedAt)}
        </span>
      </span>
    </div>
  );
}
