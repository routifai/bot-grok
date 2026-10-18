import { useSyncExternalStore } from "react";

// A comment on one step of a reply's plan (ADR 0027 "Comment"): the strip or the session panel
// sets it, the composer shows it as a chip, and the next message carries it beside its text
// (`context.stepComment`). One at a time; a send that went out clears it.

export interface StepComment {
  /** The Muse whose Conversation the step belongs to: another chat's composer never shows it. */
  botId: string;
  /** The plan card (workPlan.ts `TurnWork.planId`). */
  cardId: string;
  stepIndex: number;
  /** The step's words, as the chip shows them. */
  text: string;
}

let current: StepComment | null = null;
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** Sets (or, with null, clears) the step the next message is about. */
export function setStepComment(next: StepComment | null): void {
  if (current === next) return;
  current = next;
  for (const listener of [...listeners]) listener();
}

/** The step the next message is about, if any (read at send time). */
export const stepCommentNow = (): StepComment | null => current;

/** The step the next message to this Muse is about, if any. */
export const stepCommentFor = (botId: string): StepComment | null =>
  current?.botId === botId ? current : null;

/** The step the next message to this Muse is about, if any. */
export function useStepComment(botId: string | undefined): StepComment | null {
  const comment = useSyncExternalStore(subscribe, stepCommentNow, stepCommentNow);
  return comment && comment.botId === botId ? comment : null;
}
