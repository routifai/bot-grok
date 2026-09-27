import type { MuseState } from "@aiden/contracts";

/**
 * The Conversation header's only remaining bordered pill (docs/muse/DESIGN.md
 * "Status"): "Needs you" while an Ask is open, in the attention tone. Idle and
 * active (thinking/working) states render inline instead (`MuseLiveStatus`) —
 * no pill, no border box, no "on N things" / "last check" copy.
 */

export type StatusPillTone = "attention";

export interface StatusPillResult {
  tone: StatusPillTone;
  text: string;
}

export function deriveStatusPill(museState: MuseState): StatusPillResult | null {
  if (museState === "waiting") return { tone: "attention", text: "Needs you" };
  return null;
}
