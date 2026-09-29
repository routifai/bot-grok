import { TrendingDown, TrendingUp } from "lucide-react";
import { Badge as BadgeBase } from "../components/ui/badge.js";
import { cn } from "../lib/utils.js";
import { renderInlineMarkdown } from "./inline-markdown.js";

const HEADING_CLASS = {
  1: "text-[20px] font-semibold tracking-tight",
  2: "text-[16px] font-semibold",
  3: "text-[14px] font-semibold",
} as const;

export function CanvasHeading({ text, level = 2 }: { text: string; level?: 1 | 2 | 3 }) {
  const Tag = `h${level + 1}` as "h2" | "h3" | "h4";
  return <Tag className={cn(HEADING_CLASS[level], "text-foreground")}>{text}</Tag>;
}

export function CanvasText({ text }: { text: string }) {
  return (
    <p className="text-[14px] leading-[1.6] text-foreground/90">{renderInlineMarkdown(text)}</p>
  );
}

const TONE_CLASS = {
  neutral: "bg-muted text-muted-foreground",
  info: "bg-link/12 text-link",
  success: "bg-success/12 text-success",
  warning: "bg-warning/12 text-warning",
} as const;

export function CanvasBadge({
  text,
  tone = "neutral",
}: {
  text: string;
  tone?: keyof typeof TONE_CLASS;
}) {
  return (
    <BadgeBase variant="outline" className={cn("border-transparent font-medium", TONE_CLASS[tone])}>
      {text}
    </BadgeBase>
  );
}

const TREND_CLASS = {
  up: "text-success",
  down: "text-destructive",
  flat: "text-muted-foreground",
} as const;

export function CanvasStat({
  label,
  value,
  unit,
  delta,
  trend,
}: {
  label: string;
  value: string | number;
  unit?: string;
  delta?: string | number;
  trend?: "up" | "down" | "flat";
}) {
  const formatted =
    typeof value === "number" ? new Intl.NumberFormat("en-US").format(value) : value;
  return (
    <div className="flex flex-col gap-1 rounded-2xl border border-border bg-card px-4 py-3.5">
      <span className="text-[12.5px] text-muted-foreground">{label}</span>
      <span className="flex items-baseline gap-1 font-[Aeonik,ui-sans-serif] text-[22px] font-semibold tabular-nums text-foreground">
        {unit ? <span className="text-[15px] text-muted-foreground">{unit}</span> : null}
        {formatted}
      </span>
      {delta !== undefined ? (
        <span
          className={cn(
            "flex items-center gap-1 text-[12.5px] tabular-nums",
            trend ? TREND_CLASS[trend] : "text-muted-foreground",
          )}
        >
          {trend === "up" ? <TrendingUp size={13} strokeWidth={2} aria-hidden="true" /> : null}
          {trend === "down" ? <TrendingDown size={13} strokeWidth={2} aria-hidden="true" /> : null}
          {delta}
        </span>
      ) : null}
    </div>
  );
}

export function CanvasKeyValue({ items }: { items: { label: string; value: string }[] }) {
  return (
    <dl className="flex flex-col divide-y divide-border rounded-2xl border border-border bg-card">
      {items.map((item) => (
        <div
          key={item.label}
          className="flex items-baseline justify-between gap-4 px-4 py-2.5 text-[13.5px]"
        >
          <dt className="text-muted-foreground">{item.label}</dt>
          <dd className="text-right font-medium text-foreground">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

const CALLOUT_CLASS = {
  info: "border-link/30 bg-link/8 text-link",
  success: "border-success/30 bg-success/8 text-success",
  warning: "border-warning/30 bg-warning/8 text-warning",
} as const;

export function CanvasCallout({
  tone,
  title,
  text,
}: {
  tone: "info" | "success" | "warning";
  title?: string;
  text: string;
}) {
  return (
    <div role="note" className={cn("rounded-2xl border px-4 py-3", CALLOUT_CLASS[tone])}>
      {title ? <div className="mb-0.5 text-[13.5px] font-semibold">{title}</div> : null}
      <div className="text-[13.5px] leading-[1.5] text-foreground/85">
        {renderInlineMarkdown(text)}
      </div>
    </div>
  );
}

export function CanvasQuote({ text, attribution }: { text: string; attribution?: string }) {
  return (
    <blockquote className="border-l-2 border-l-border pl-4 text-[14.5px] leading-[1.6] text-foreground/85 italic">
      {renderInlineMarkdown(text)}
      {attribution ? (
        <footer className="mt-1 text-[12.5px] text-muted-foreground not-italic">
          {attribution}
        </footer>
      ) : null}
    </blockquote>
  );
}

export function CanvasSourceList({
  sources,
}: {
  sources: { title: string; url: string; domain?: string }[];
}) {
  return (
    <ul className="flex flex-col gap-1.5">
      {sources.map((source, index) => (
        <li
          key={`${source.url}-${index}`}
          className="flex min-w-0 items-baseline gap-2 text-[13px]"
        >
          <span aria-hidden="true" className="text-muted-foreground">
            {index + 1}.
          </span>
          <a
            href={source.url || undefined}
            target="_blank"
            rel="noreferrer noopener"
            className="min-w-0 truncate text-link underline-offset-2 hover:underline"
          >
            {source.title || source.url}
          </a>
          {source.domain ? (
            <span className="shrink-0 text-muted-foreground">{source.domain}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
