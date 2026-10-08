import type { Activity } from "@aiden/contracts";
import { cn } from "@aiden/ui-web";
import { useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";
import { RunStatusDot } from "./RunStatusDot";

/**
 * One piece of work as a quiet two-line row (the "Working" line, shared by the Activity panel
 * and the Helper rows under a message): a status dot, the title, a mono figure on the right
 * (how long it has gone, or the clock), and under the title either "Now · <live step>" while it
 * works or one muted line once it has settled.
 */
export function ActivityLine({
  status,
  title,
  meta,
  liveStep,
  detail,
  nested = false,
  onClick,
  testId,
}: {
  /** Undefined while the feed has not listed it yet: a plain muted dot. */
  status?: Activity["status"];
  title: string;
  /** Mono figures on the right: an elapsed time, a duration, a clock time. */
  meta?: ReactNode;
  /** What it is doing right now; shown as "Now · …" while it works. */
  liveStep?: string;
  /** The one muted line under a settled row (an outcome, "Didn't finish"). */
  detail?: string;
  nested?: boolean;
  onClick?: () => void;
  testId?: string;
}) {
  const { t } = useLingui();
  const body = (
    <>
      <span className="flex h-5 items-center justify-center">
        {status ? (
          <RunStatusDot status={status} />
        ) : (
          <span aria-hidden="true" className="size-1.5 rounded-full bg-ink-3/60" />
        )}
      </span>
      <span
        data-testid="activity-line-title"
        className={cn(
          "min-w-0 truncate leading-5 text-foreground",
          nested ? "text-[13px]" : "text-[13.5px] font-medium",
        )}
        dir="auto"
      >
        {title}
      </span>
      {meta ? (
        <span className="shrink-0 font-mono text-[11.5px] leading-5 whitespace-nowrap text-ink-3 tabular-nums">
          {meta}
        </span>
      ) : (
        <span />
      )}
      {liveStep ? (
        <span
          className="col-start-2 col-end-4 truncate text-[12.5px] leading-[18px] text-ink-2"
          aria-live="polite"
          dir="auto"
        >
          <span className="font-medium text-foreground">{t`Now`}</span> · {liveStep}
        </span>
      ) : detail ? (
        <span
          className={cn(
            "col-start-2 col-end-4 truncate text-[12.5px] leading-[18px]",
            status === "failed" ? "text-ink-2" : "text-ink-3",
          )}
          dir="auto"
        >
          {detail}
        </span>
      ) : null}
    </>
  );
  const className =
    "grid w-full grid-cols-[12px_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-px rounded-lg px-2 py-1.5 text-start";
  if (!onClick) return <div className={className}>{body}</div>;
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      data-status={status}
      className={cn(
        className,
        "transition-colors hover:bg-selection focus-visible:outline-2 focus-visible:outline-ring",
      )}
    >
      {body}
    </button>
  );
}

/** A Helper's parts, hung off its row on a thin connector line. */
export function ActivityBranch({ children }: { children: ReactNode }) {
  return <div className="ms-[13px] flex flex-col border-s border-line ps-1">{children}</div>;
}
