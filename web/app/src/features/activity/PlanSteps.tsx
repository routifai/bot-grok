import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { cn } from "@superchat/ui-web";
import { Check, ChevronDown, TriangleAlert, X } from "lucide-react";
import { useState } from "react";
import { SuperchatOrb } from "../../components/ai/orb";
import { Shimmer } from "../../components/ai/primitives";
import type { PlanStep } from "./workPlan";

// A reply's plan as the engine reads it (ADR 0027 "Display is the engine's"), drawn the same way
// in the work strip (compact) and the session panel (full): earlier done steps folded, the
// current step in its present tense with the latest line of the work under it, and each step's
// reading (done, doing, to do, not checked, stopped, failed). A model's tick with nothing behind
// it (`claimed`) reads as to do.

/** A step still to come: to do, or ticked by the model with nothing behind it. */
const ahead = (step: PlanStep) => step.status === "todo" || step.status === "claimed";

/** Where the compact strip stops: the last step doing, else the first not done; -1 when all are. */
function currentIndex(plan: readonly PlanStep[]): number {
  const doing = plan.findLastIndex((step) => step.status === "doing");
  return doing >= 0 ? doing : plan.findIndex((step) => step.status !== "done");
}

/** The step the work is on (the strip's headline), if any. */
export function currentStep(plan: readonly PlanStep[]): PlanStep | undefined {
  return plan[currentIndex(plan)];
}

/** What a step says: its present tense while it is doing. */
export const stepWords = (step: PlanStep) =>
  step.status === "doing" && step.active ? step.active : step.text;

function StepMark({ step }: { step: PlanStep }) {
  switch (step.status) {
    case "done":
      return (
        <span className="sc-work-pop grid size-[15px] place-items-center rounded-full bg-foreground text-content">
          <Check size={10} strokeWidth={3} />
        </span>
      );
    case "doing":
      return <SuperchatOrb size={13} state="working" flies={false} />;
    case "failed":
      return (
        <span className="grid size-[15px] place-items-center rounded-full bg-destructive text-content">
          <X size={10} strokeWidth={3} />
        </span>
      );
    case "not_checked":
      return <TriangleAlert size={13} strokeWidth={2.2} className="text-warning" />;
    case "stopped":
      return (
        <span className="size-[11px] rounded-full border-[1.5px] border-dashed border-ink-3" />
      );
    default:
      return <span className="size-[11px] rounded-full border-[1.5px] border-ink-3 opacity-70" />;
  }
}

/** One step: its mark, its words, its reading when it is not plain, the latest line of the work
 * while it is doing, the step after it (compact), and "Comment" on hover or focus. */
function StepRow({
  step,
  progress,
  then,
  onComment,
}: {
  step: PlanStep;
  progress: string | null;
  then: PlanStep | undefined;
  onComment: (() => void) | undefined;
}) {
  const { t } = useLingui();
  const reading =
    step.status === "not_checked"
      ? t`Not checked`
      : step.status === "stopped"
        ? t`Stopped`
        : step.status === "failed"
          ? t`Didn't finish`
          : null;
  const words = stepWords(step);
  return (
    <li
      data-testid="work-plan-step"
      data-status={step.status}
      data-added={step.added || undefined}
      data-changed={step.changed || undefined}
      className={cn(
        "group/step grid grid-cols-[20px_minmax(0,1fr)_auto] items-start gap-x-[9px] rounded-[7px] py-1 text-[13.5px] leading-[1.4] transition-colors duration-300",
        ahead(step) && "text-ink-3",
        step.status === "stopped" && "text-ink-2",
        step.status === "doing" && "font-[560] text-foreground",
        (step.status === "done" || step.status === "not_checked" || step.status === "failed") &&
          "text-foreground",
        step.added && "sc-work-added",
      )}
    >
      <span aria-hidden="true" className="grid size-5 place-items-center">
        <StepMark step={step} />
      </span>
      <span className="min-w-0" dir="auto">
        <span key={words} className="sc-work-in">
          {words}
        </span>
        {reading ? (
          <span
            data-testid="work-plan-reading"
            className={cn(
              "ms-1.5 text-[12.5px] font-normal",
              step.status === "not_checked" && "text-warning",
              step.status === "failed" && "text-destructive",
              step.status === "stopped" && "text-ink-3",
            )}
          >
            {reading}
          </span>
        ) : null}
      </span>
      {onComment ? (
        <button
          type="button"
          data-testid="work-plan-comment"
          aria-label={t`Comment on ${words}`}
          onClick={onComment}
          className="rounded-full border border-separator bg-content px-2 text-[11.5px] font-normal text-foreground opacity-0 transition-opacity group-focus-within/step:opacity-100 group-hover/step:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 focus-visible:outline-2 focus-visible:outline-ring"
        >
          {t`Comment`}
        </button>
      ) : (
        <span />
      )}
      {step.status === "doing" && progress ? (
        <span
          key={progress}
          data-testid="work-plan-progress"
          className="sc-work-in col-start-2 mt-px text-[12.5px] font-normal text-ink-2"
          dir="auto"
          aria-live="polite"
        >
          <Shimmer>{progress}</Shimmer>
        </span>
      ) : null}
      {then ? (
        <span
          data-testid="work-plan-then"
          className="col-start-2 mt-px text-[12.5px] font-normal text-ink-3"
          dir="auto"
        >
          {t`Then: ${then.text}`}
        </span>
      ) : null}
    </li>
  );
}

/**
 * The plan's steps. Earlier done steps fold under "N earlier steps" (the last two stay), opened
 * with a toggle. `compact` (the live strip) stops at the current step and names the next one
 * under it ("Then: …"); otherwise every step shows. `onComment` puts a step in the composer.
 */
export function PlanSteps({
  plan,
  fold: engineFold = 0,
  progress,
  compact = false,
  onComment,
}: {
  plan: readonly PlanStep[];
  /** Leading done steps that fold away, as the engine counts them (ADR 0027). */
  fold?: number;
  /** The latest line of the running work, under the step doing. */
  progress: string | null;
  compact?: boolean;
  onComment?: (index: number, step: PlanStep) => void;
}) {
  const { t } = useLingui();
  const [unfolded, setUnfolded] = useState(false);
  const current = currentIndex(plan);
  // Never fold the step the work is on.
  const fold = Math.max(0, Math.min(engineFold, current >= 0 ? current : plan.length));
  const end = compact && current >= 0 ? current + 1 : plan.length;
  const then =
    compact && current >= 0 ? plan.slice(current + 1).find((step) => ahead(step)) : undefined;
  const start = unfolded ? 0 : fold;
  return (
    <ul data-testid="work-plan" className="m-0 flex list-none flex-col p-0">
      {fold > 0 ? (
        <li>
          <button
            type="button"
            data-testid="work-plan-fold"
            aria-expanded={unfolded}
            onClick={() => setUnfolded((value) => !value)}
            className="inline-flex items-center gap-[9px] rounded-sm py-1 text-[12.5px] text-ink-2 transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            <span aria-hidden="true" className="grid w-5 place-items-center">
              <ChevronDown
                size={13}
                strokeWidth={2}
                className={cn("transition-transform duration-200", unfolded && "rotate-180")}
              />
            </span>
            {unfolded
              ? t`Hide earlier steps`
              : plural(fold, { one: "# earlier step", other: "# earlier steps" })}
          </button>
        </li>
      ) : null}
      {plan.slice(start, end).map((step, offset) => {
        const index = start + offset;
        return (
          <StepRow
            // Steps are their words; a repeated step keeps its place.
            key={`${step.text}#${plan.slice(0, index).filter((s) => s.text === step.text).length}`}
            step={step}
            progress={progress}
            then={index === current ? then : undefined}
            onComment={onComment ? () => onComment(index, step) : undefined}
          />
        );
      })}
    </ul>
  );
}
