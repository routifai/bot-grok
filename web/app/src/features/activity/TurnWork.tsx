import { createContext, type ReactNode, useContext, useMemo } from "react";
import { drawnKey, type TranscriptWork, type TurnWork } from "./workPlan";
import type { StripHelper, StripTurn } from "./workStripState";

type Value = { work: TranscriptWork; running: boolean; liveLabel: string | undefined };

const TurnWorkContext = createContext<Value | null>(null);

/** Wrap a transcript once with its `transcriptWork` (workPlan.ts): each reply's strip then finds
 * its plan and running state, and the plan cards a strip draws stay out of the transcript. */
export function TurnWorkProvider({
  work,
  running,
  liveLabel,
  children,
}: {
  work: TranscriptWork;
  /** The newest reply is being written. */
  running: boolean;
  /** What the running turn is doing now ("Reading files…"). */
  liveLabel?: string;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ work, running, liveLabel }), [work, running, liveLabel]);
  return <TurnWorkContext.Provider value={value}>{children}</TurnWorkContext.Provider>;
}

/** The strip a message carries (it is its reply's anchor), or null. */
export function useTurnStrip(
  messageId: string,
): { helpers: StripHelper[]; turn: StripTurn } | null {
  const value = useContext(TurnWorkContext);
  const found: TurnWork | undefined = value?.work.turns.get(messageId);
  const live = Boolean(found?.last && value?.running);
  const liveLabel = live ? value?.liveLabel : undefined;
  return useMemo(
    () =>
      found
        ? {
            helpers: found.helpers,
            turn: {
              plan: found.plan,
              live,
              startedAt: found.startedAt,
              endedAt: found.endedAt,
              ...(liveLabel ? { liveLabel } : {}),
            },
          }
        : null,
    [found, live, liveLabel],
  );
}

/** Whether a strip draws this card (the reply's living plan), so the card itself is not shown. */
export function useDrawnByStrip(): (messageId: string, index: number) => boolean {
  const drawn = useContext(TurnWorkContext)?.work.drawn;
  return (messageId, index) => Boolean(drawn?.has(drawnKey(messageId, index)));
}
