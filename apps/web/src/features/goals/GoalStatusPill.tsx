import { useLingui } from "@lingui/react/macro";
import type { Goal } from "@nova/contracts";
import { StatusPill } from "../ui";
import { type GoalDisplayStatus, goalDisplayStatus } from "./format";

const TONE: Record<GoalDisplayStatus, "neutral" | "live" | "attention" | "done"> = {
  waiting: "attention",
  working: "live",
  paused: "neutral",
  noPlan: "neutral",
  onTrack: "done",
};

/** The `StatusPill` for a Goal's derived state — waiting on you / working / paused / on track. */
export function GoalStatusPill({ goal, className }: { goal: Goal; className?: string }) {
  const { t } = useLingui();
  const status = goalDisplayStatus(goal);
  const label: Record<GoalDisplayStatus, string> = {
    waiting: t`Waiting on you`,
    working: t`Working`,
    paused: t`Paused`,
    noPlan: t`No plan yet`,
    onTrack: t`On track`,
  };
  return (
    <StatusPill tone={TONE[status]} className={className}>
      {label[status]}
    </StatusPill>
  );
}
