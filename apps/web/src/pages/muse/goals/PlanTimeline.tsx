import type { GoalTask, GoalTaskStatus } from "@aiden/contracts";
import { cn } from "@aiden/ui-web";
import { Trans } from "@lingui/react/macro";
import { Ban, Check, Minus } from "lucide-react";
import { goalTaskStatusLabel } from "./taskStatusLabel";

const NODE = "relative z-10 flex size-5 shrink-0 items-center justify-center rounded-full";

/**
 * A Task's status as a marker on the Plan timeline: a hollow circle (pending), a pulsing
 * half-fill (in progress), a filled check (done), a warning ring (blocked), or a muted dash
 * (skipped). Shape carries the meaning, never color alone — see docs/muse/DESIGN.md "Goals".
 */
function PlanNode({ status }: { status: GoalTaskStatus }) {
  if (status === "done") {
    return (
      <span className={cn(NODE, "border border-success/50 bg-success/15 text-success")}>
        <Check size={12} strokeWidth={2.5} aria-hidden="true" />
      </span>
    );
  }
  if (status === "blocked") {
    return (
      <span className={cn(NODE, "border border-warning/50 bg-warning/15 text-warning")}>
        <Ban size={12} strokeWidth={2.25} aria-hidden="true" />
      </span>
    );
  }
  if (status === "skipped") {
    return (
      <span className={cn(NODE, "border border-border bg-background text-muted-foreground/70")}>
        <Minus size={12} strokeWidth={2.5} aria-hidden="true" />
      </span>
    );
  }
  if (status === "in_progress") {
    return (
      <span
        className={cn(NODE, "overflow-hidden border border-foreground/60 bg-background")}
        aria-hidden="true"
      >
        <span className="absolute inset-y-0 left-0 w-1/2 bg-foreground/70 motion-safe:animate-[rkPulse_2.4s_ease-in-out_infinite]" />
      </span>
    );
  }
  return <span className={cn(NODE, "border border-border bg-background")} />;
}

/** The Goal's plan: a thin vertical line connecting each Task's status node, in plan order. */
export function PlanTimeline({ tasks }: { tasks: GoalTask[] }) {
  if (tasks.length === 0) {
    return (
      <p className="text-[13.5px] text-muted-foreground">
        <Trans>No tasks yet</Trans>
      </p>
    );
  }
  return (
    <ol className="relative" data-testid="goal-task-list">
      <div aria-hidden="true" className="absolute top-2.5 bottom-2.5 left-2.5 w-px bg-border" />
      {tasks.map((task, index) => (
        <li key={task.id} className={cn("relative flex gap-3", index < tasks.length - 1 && "pb-5")}>
          <PlanNode status={task.status} />
          <div className="min-w-0 flex-1 pb-0.5">
            <span className="text-[14.5px] text-foreground" dir="auto">
              {task.title}
            </span>
            <span className="sr-only"> — {goalTaskStatusLabel(task.status)}</span>
            {task.note ? (
              <p className="mt-0.5 text-[13px] text-muted-foreground" dir="auto">
                {task.note}
              </p>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
