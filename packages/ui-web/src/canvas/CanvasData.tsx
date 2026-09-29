import { Check, Circle, CircleDot } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "../lib/utils.js";
import { useReducedMotion } from "./use-reduced-motion.js";

const PROGRESS_TONE = {
  neutral: "bg-primary",
  success: "bg-success",
  warning: "bg-warning",
} as const;

export function CanvasProgress({
  label,
  value,
  tone = "neutral",
}: {
  label?: string;
  value: number;
  tone?: keyof typeof PROGRESS_TONE;
}) {
  const reducedMotion = useReducedMotion();
  const [grown, setGrown] = useState(reducedMotion);
  useEffect(() => {
    if (reducedMotion) return;
    const id = requestAnimationFrame(() => setGrown(true));
    return () => cancelAnimationFrame(id);
  }, [reducedMotion]);
  return (
    <div className="flex flex-col gap-1.5">
      {label ? (
        <div className="flex items-baseline justify-between text-[12.5px]">
          <span className="text-muted-foreground">{label}</span>
          <span className="tabular-nums font-medium text-foreground">{Math.round(value)}%</span>
        </div>
      ) : null}
      <div
        role="progressbar"
        aria-valuenow={Math.round(value)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-700 motion-reduce:transition-none",
            PROGRESS_TONE[tone],
          )}
          style={{ width: `${grown ? value : 0}%` }}
        />
      </div>
    </div>
  );
}

const TIMELINE_ICON = {
  done: <Check size={12} strokeWidth={2.5} className="text-success-foreground" />,
  active: <CircleDot size={10} strokeWidth={2.5} className="text-primary-foreground" />,
  upcoming: <Circle size={8} strokeWidth={2.5} className="text-muted-foreground" />,
} as const;

const TIMELINE_DOT_CLASS = {
  done: "bg-success",
  active: "bg-primary",
  upcoming: "bg-muted border border-border",
} as const;

export function CanvasTimeline({
  items,
}: {
  items: {
    date?: string;
    title: string;
    detail?: string;
    status?: "done" | "active" | "upcoming";
  }[];
}) {
  return (
    <ol className="flex flex-col">
      {items.map((item, index) => {
        const status = item.status ?? "upcoming";
        const isLast = index === items.length - 1;
        return (
          <li key={`${item.title}-${index}`} className="flex gap-3">
            <div className="flex flex-col items-center">
              <span
                className={cn(
                  "flex size-5 shrink-0 items-center justify-center rounded-full",
                  TIMELINE_DOT_CLASS[status],
                )}
              >
                {TIMELINE_ICON[status]}
              </span>
              {!isLast ? <span className="w-px flex-1 bg-border" /> : null}
            </div>
            <div className={cn("min-w-0 pb-4", isLast ? "pb-0" : undefined)}>
              {item.date ? (
                <div className="text-[11.5px] text-muted-foreground">{item.date}</div>
              ) : null}
              <div className="text-[13.5px] font-medium text-foreground">{item.title}</div>
              {item.detail ? (
                <div className="mt-0.5 text-[12.5px] text-muted-foreground">{item.detail}</div>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function CanvasChecklist({ items }: { items: { text: string; done?: boolean }[] }) {
  return (
    <ul className="flex flex-col gap-1.5">
      {items.map((item, index) => (
        <li key={`${item.text}-${index}`} className="flex items-start gap-2 text-[13.5px]">
          <span
            aria-hidden="true"
            className={cn(
              "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[5px] border",
              item.done ? "border-success bg-success" : "border-border bg-transparent",
            )}
          >
            {item.done ? (
              <Check size={11} strokeWidth={3} className="text-success-foreground" />
            ) : null}
          </span>
          <span
            className={cn(item.done ? "text-muted-foreground line-through" : "text-foreground/90")}
          >
            {item.text}
          </span>
        </li>
      ))}
    </ul>
  );
}
