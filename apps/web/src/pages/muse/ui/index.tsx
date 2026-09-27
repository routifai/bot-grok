import { cn } from "@rakazo/ui-web";
import type { ComponentProps, ReactNode } from "react";

// Shared building blocks for the Muse screens (docs/muse/DESIGN.md). Every Muse screen
// composes these so spacing, type, and surfaces stay identical across Goals, Feed,
// Library, and Waiting on you. Colors come only from the semantic tokens.

/** Centered reading column shared by every Muse screen. */
export function MuseColumn({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("mx-auto flex w-full max-w-[720px] flex-col px-5 sm:px-8", className)}
      {...props}
    />
  );
}

/**
 * Wide, left-aligned layout for screens that fill the panel instead of reading like a
 * document (Goals, Feed, Library): generous left padding, capped at ~1120px so lines don't
 * run edge-to-edge on a big screen, but never centered — using the space is the point.
 */
export function MuseWideColumn({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("flex w-full max-w-[1120px] flex-col pl-5 pr-5 sm:pl-12 sm:pr-8", className)}
      {...props}
    />
  );
}

/** Scroll container for a Muse screen: full height, quiet scrollbar, generous bottom room. */
export function MuseScreen({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("rk-scroll h-full min-w-0 overflow-y-auto bg-background pb-24", className)}
      {...props}
    />
  );
}

/** Serif screen title with an optional one-line subtitle and trailing actions. */
export function ScreenHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex items-end justify-between gap-4 pt-10 pb-6">
      <div className="min-w-0">
        <h1 className="font-display text-[32px] leading-[1.1] tracking-[-0.01em] text-foreground">
          {title}
        </h1>
        {subtitle ? <p className="mt-2 text-[13.5px] text-muted-foreground">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** Small uppercase label above a group or inside a card. */
export function Eyebrow({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "font-mono text-[11.5px] font-medium uppercase tracking-[0.08em] text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

/** Section inside a screen: an eyebrow title and its content. */
export function Section({
  title,
  action,
  className,
  children,
}: {
  title?: ReactNode;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn("flex flex-col gap-3", className)}>
      {title || action ? (
        <div className="flex items-center justify-between gap-3">
          {title ? <Eyebrow>{title}</Eyebrow> : <span />}
          {action}
        </div>
      ) : null}
      {children}
    </section>
  );
}

type SurfaceTone = "default" | "attention" | "quiet";

/**
 * The one card surface. `attention` is for things waiting on the person (warm tint and
 * edge); `quiet` is for secondary content (muted fill, no border).
 */
export function Surface({
  tone = "default",
  interactive = false,
  className,
  ...props
}: ComponentProps<"div"> & { tone?: SurfaceTone; interactive?: boolean }) {
  return (
    <div
      className={cn(
        "rounded-2xl",
        tone === "default" && "border border-border bg-card",
        tone === "attention" && "border border-warning/35 bg-warning/[0.06]",
        tone === "quiet" && "bg-muted",
        interactive &&
          "cursor-pointer transition-[border-color,box-shadow] duration-150 hover:border-ring/50 hover:shadow-float focus-visible:outline-2 focus-visible:outline-ring",
        className,
      )}
      {...props}
    />
  );
}

type PillTone = "neutral" | "live" | "attention" | "done";

/** Rounded status pill with a leading dot. `live` pulses gently. */
export function StatusPill({
  tone = "neutral",
  className,
  onClick,
  label,
  children,
}: {
  tone?: PillTone;
  className?: string;
  /** Makes the pill a button, e.g. to open what's waiting. */
  onClick?: () => void;
  /** Accessible name when the pill is a button. */
  label?: string;
  children: ReactNode;
}) {
  const content = (
    <>
      <span
        aria-hidden="true"
        className="relative flex size-2 shrink-0 items-center justify-center"
      >
        {tone === "attention" || tone === "live" ? (
          <span
            className={cn(
              "absolute inline-flex size-full animate-ping rounded-full opacity-60 motion-reduce:animate-none",
              tone === "attention" ? "bg-warning" : "bg-success",
            )}
          />
        ) : null}
        <span
          className={cn(
            "relative size-1.5 rounded-full",
            tone === "neutral" && "bg-muted-foreground/60",
            tone === "live" && "bg-success",
            tone === "attention" && "bg-warning",
            tone === "done" && "bg-success",
          )}
        />
      </span>
      {children}
    </>
  );
  const classes = cn(
    "inline-flex min-w-0 items-center gap-2 rounded-full border px-3 py-1 text-[13px] font-medium",
    tone === "attention"
      ? "border-warning/40 bg-warning/[0.08] text-foreground"
      : "border-border bg-card text-muted-foreground",
    onClick &&
      "cursor-pointer transition-colors hover:border-warning/70 focus-visible:outline-2 focus-visible:outline-ring",
    className,
  );
  return onClick ? (
    <button type="button" onClick={onClick} aria-label={label} className={classes}>
      {content}
    </button>
  ) : (
    <span className={classes}>{content}</span>
  );
}

/** Pill-shaped choice or suggestion. */
export function Chip({
  className,
  selected = false,
  ...props
}: ComponentProps<"button"> & { selected?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] transition-colors",
        selected
          ? "border-foreground bg-foreground text-background"
          : "border-border bg-card text-foreground hover:bg-accent",
        "focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

/** Label/value rows, e.g. the To / Subject / Body of an email waiting for approval. */
export function DetailRows({ rows }: { rows: { label: ReactNode; value: ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-[88px_1fr] gap-x-4 gap-y-2 text-[13.5px]">
      {rows.map((row, index) => (
        <div key={index} className="contents">
          <dt className="pt-px font-mono text-[11px] uppercase tracking-[0.06em] text-muted-foreground">
            {row.label}
          </dt>
          <dd className="min-w-0 break-words text-foreground">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Thin progress bar (done / total), ink on muted. */
export function Progress({ value, label }: { value: number; label: string }) {
  const clamped = Math.max(0, Math.min(1, value));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped * 100)}
      className="h-1 w-full overflow-hidden rounded-full bg-muted"
    >
      <div
        className="h-full rounded-full bg-foreground transition-[width] duration-300"
        style={{ width: `${clamped * 100}%` }}
      />
    </div>
  );
}

/** One quiet line for empty states, optionally with a serif lead. */
export function EmptyState({ lead, children }: { lead?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-1 py-10">
      {lead ? (
        <p className="font-display text-[24px] leading-tight text-foreground">{lead}</p>
      ) : null}
      <p className="text-[14px] text-muted-foreground">{children}</p>
    </div>
  );
}
