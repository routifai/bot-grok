import type { GoalTaskStatus } from "@nova/contracts";
import { cn } from "@nova/ui-web";
import { Ban, Check, Minus } from "lucide-react";
import type { ReactNode } from "react";
import { goalTaskStatusLabel } from "./taskStatusLabel";

/** A Goal's progress as an Activity-style ring in the Muse's color. */
export function GoalRing({
  value,
  color,
  toneClass,
  size = "md",
}: {
  value: number;
  /** A raw color (the detail view's Muse color); `toneClass` wins when given. */
  color?: string;
  /** A stroke token class, e.g. `stroke-sig-goals`. */
  toneClass?: string;
  size?: "sm" | "md" | "lg";
}) {
  const radius = 17;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg
      viewBox="0 0 40 40"
      className={cn(
        "shrink-0 -rotate-90",
        size === "lg" ? "size-16" : size === "sm" ? "size-11" : "size-12",
      )}
      aria-hidden="true"
    >
      <circle cx="20" cy="20" r={radius} fill="none" strokeWidth="4" className="stroke-selection" />
      {value > 0 ? (
        <circle
          cx="20"
          cy="20"
          r={radius}
          fill="none"
          strokeWidth="4"
          strokeLinecap="round"
          stroke={toneClass ? undefined : color}
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - Math.min(1, value))}
          className={cn("transition-[stroke-dashoffset] duration-700 ease-out", toneClass)}
        />
      ) : null}
    </svg>
  );
}

export type GoalStepState = "done" | "working" | "next" | "blocked" | "skipped";

export function stepStateOf(status: GoalTaskStatus): GoalStepState {
  if (status === "done") return "done";
  if (status === "in_progress") return "working";
  if (status === "blocked") return "blocked";
  if (status === "skipped") return "skipped";
  return "next";
}

/** One step of a plan: a round marker whose shape carries the state, then the title. */
export function GoalStep({
  state,
  children,
  note,
  status,
}: {
  state: GoalStepState;
  children: ReactNode;
  note?: string | null;
  status?: GoalTaskStatus;
}) {
  return (
    <li className="flex items-start gap-3 py-[7px]">
      <span
        aria-hidden="true"
        className={cn(
          "mt-px grid size-[22px] shrink-0 place-items-center rounded-full",
          state === "done" && "bg-foreground text-background",
          state === "working" && "border-2 border-foreground",
          state === "next" && "border-[1.5px] border-border",
          state === "blocked" && "bg-warning/15 text-warning",
          state === "skipped" && "border-[1.5px] border-border text-muted-foreground/70",
        )}
      >
        {state === "done" ? <Check size={13} strokeWidth={3} /> : null}
        {state === "working" ? (
          <span className="size-2 rounded-full bg-foreground motion-safe:animate-pulse" />
        ) : null}
        {state === "blocked" ? <Ban size={12} strokeWidth={2.25} /> : null}
        {state === "skipped" ? <Minus size={12} strokeWidth={2.5} /> : null}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block text-[15px] tracking-[-0.01em]",
            state === "done" || state === "skipped" ? "text-muted-foreground" : "text-foreground",
            state === "skipped" && "line-through",
            state === "working" && "font-medium",
          )}
          dir="auto"
        >
          {children}
        </span>
        {status ? <span className="sr-only"> — {goalTaskStatusLabel(status)}</span> : null}
        {note ? (
          <span className="mt-0.5 block text-[13.5px] text-muted-foreground" dir="auto">
            {note}
          </span>
        ) : null}
      </span>
    </li>
  );
}
