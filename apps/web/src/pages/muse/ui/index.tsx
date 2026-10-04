import type { IllustrationKey } from "@aiden/contracts";
import { DEFAULT_MUSE_COLOR } from "@aiden/contracts";
import { BotAvatar, cn } from "@aiden/ui-web";
import type { ComponentProps, ReactNode } from "react";
import { illustrationUrl } from "../../../lib/illustrations";

// Shared building blocks for the Muse screens (docs/muse/DESIGN.md). Every Muse screen
// composes these so spacing, type, and surfaces stay identical across Conversation,
// Goals, Feed, Ideas, Library, and Waiting on you. Colors come only from the semantic
// tokens; type comes only from the scale below.

/**
 * The one Muse type scale. Instrument Sans everywhere (it's the edition's inherited
 * body font — never `font-display`, which is reserved for the signed-out welcome and
 * auth screens). Geist Mono (`label`) is for small tags only, never a whole heading.
 */
/** iOS-style inset grouped list: one rounded card whose rows are split by inset hairlines. */
export const MUSE_INSET_GROUP =
  "overflow-hidden rounded-[22px] bg-card shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_-14px_rgb(0_0_0/0.14)] ring-1 ring-border/60";

export const MUSE_TYPE = {
  /** The screen's name in the shared top chrome bar (`ScreenHeader`). */
  chromeTitle: "text-[17px] font-semibold tracking-[-0.01em] text-foreground",
  /** A big in-content heading for a screen that reads like its own page (Ideas). */
  pageTitle: "text-[34px] font-bold leading-[1.1] tracking-[-0.025em] text-foreground",
  /** A one-line page subtitle under `pageTitle`, in the Muse's own voice. */
  pageSubtitle: "text-[17px] leading-[1.5] text-muted-foreground",
  /** A group heading inside a screen ("Productivity", "Paused", "Plan"). */
  sectionTitle: "text-[15px] font-semibold text-foreground",
  /** A card's or row's own title (a Goal, a Post, a Library item, an Idea). */
  cardTitle: "text-[16px] font-semibold leading-snug text-foreground",
  /** Regular reading text inside a card or row. */
  body: "text-[15px] leading-[1.55] text-foreground/90",
  /** A quiet fact line — dates, counts, sources. */
  meta: "text-[13px] text-muted-foreground",
  /** A small mono label, sparingly (a card's type tag) — never a whole heading. */
  label: "font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground",
} as const;

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

/**
 * Scroll container for a Muse screen: an optional fixed `header` (the shared
 * `ScreenHeader` chrome, outside the scroll like the Conversation's), then a quiet
 * scrolling body with generous bottom room. Content fades under the top edge once
 * scrolled (`data-fade-top` + `data-scrolled`, styles.css) — the same mask the floating
 * Conversation chrome uses over its transcript, so every section shares the effect.
 */
export function MuseScreen({
  header,
  className,
  children,
  onScroll,
  ...props
}: ComponentProps<"div"> & { header?: ReactNode }) {
  return (
    <div className="flex h-full min-w-0 flex-col">
      {header}
      <div
        data-fade-top=""
        onScroll={(event) => {
          event.currentTarget.dataset.scrolled = String(event.currentTarget.scrollTop > 4);
          onScroll?.(event);
        }}
        className={cn("rk-scroll min-w-0 flex-1 overflow-y-auto pb-24", className)}
        {...props}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * The one top chrome bar, shared by every Muse section (docs/muse/DESIGN.md): same
 * height, padding and hairline border as the Conversation's, a title, optional inline
 * `meta` next to it (a status pill, a count), and a right-side `actions` slot.
 */
export function ScreenHeader({
  title,
  meta,
  actions,
  /** True for a header that also serves as the desktop window's drag region. */
  dragRegion = false,
}: {
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  dragRegion?: boolean;
}) {
  return (
    <header
      className={cn(
        "flex h-16 shrink-0 items-center justify-between gap-3 px-4 md:px-6",
        dragRegion && "app-drag",
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className={cn("truncate", MUSE_TYPE.chromeTitle)}>{title}</span>
        {meta}
      </div>
      {actions ? (
        <div className={cn("flex shrink-0 items-center gap-1", dragRegion && "app-no-drag")}>
          {actions}
        </div>
      ) : null}
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

/** Section inside a screen: a plain sentence-case title and its content. */
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
          {title ? <h2 className={MUSE_TYPE.sectionTitle}>{title}</h2> : <span />}
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

/**
 * Label/value rows, e.g. the To / Subject / Body of an email waiting for approval: a
 * compact two-column grid in a subtle muted panel, labels muted in normal case (not mono,
 * not uppercase).
 */
export function DetailRows({ rows }: { rows: { label: ReactNode; value: ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-[76px_1fr] gap-x-3 gap-y-1.5 rounded-lg bg-muted/50 p-3 text-[14px]">
      {rows.map((row, index) => (
        <div key={index} className="contents">
          <dt className="text-muted-foreground">{row.label}</dt>
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

/**
 * The one empty state (docs/muse/DESIGN.md): centered in the available space, the
 * Muse's face, a plain sans headline, one muted line, and — when `suggestions` and
 * `onSuggestion` are both given — a few chips that start a Conversation with that
 * prompt. Omit both for a quieter inline message (e.g. "nothing matches your search"),
 * which drops the face and chips but keeps the same centered, breathing layout.
 */
export function EmptyState({
  avatarColor,
  headline,
  children,
  suggestions,
  onSuggestion,
  face,
  illustration,
  className,
}: {
  /** The Muse's identity color; defaults to gold when the screen has none handy. */
  avatarColor?: string;
  /** Show the Muse's face even without suggestions (it always shows with them). */
  face?: boolean;
  /**
   * A bundled 3D illustration fitting this section (e.g. a trophy for Goals, books for
   * Library), tilted beside the Muse's face — a companion to the hero, never a
   * replacement. Only shown alongside the face.
   */
  illustration?: IllustrationKey;
  headline?: ReactNode;
  children?: ReactNode;
  suggestions?: readonly string[];
  onSuggestion?: (text: string) => void;
  className?: string;
}) {
  const rich = Boolean(suggestions?.length && onSuggestion);
  const showFace = rich || face;
  return (
    <div
      className={cn(
        "flex flex-1 flex-col items-center justify-center gap-4 px-6 py-16 text-center",
        className,
      )}
    >
      {showFace ? (
        <div className="relative">
          <BotAvatar
            color={avatarColor ?? DEFAULT_MUSE_COLOR}
            identity="aiden"
            face="muse"
            size={88}
          />
          {illustration ? (
            <img
              src={illustrationUrl(illustration)}
              alt=""
              loading="lazy"
              className="-right-3 -bottom-1.5 absolute size-9 rotate-[10deg] drop-shadow-sm"
            />
          ) : null}
        </div>
      ) : null}
      <div className="max-w-[380px]">
        {headline ? <p className="text-[18px] font-semibold text-foreground">{headline}</p> : null}
        {children ? (
          <p className={cn("text-[14px] text-muted-foreground", headline ? "mt-1.5" : undefined)}>
            {children}
          </p>
        ) : null}
      </div>
      {rich ? (
        <div className="flex flex-wrap justify-center gap-2 pt-1">
          {suggestions?.map((text) => (
            <Chip key={text} onClick={() => onSuggestion?.(text)}>
              {text}
            </Chip>
          ))}
        </div>
      ) : null}
    </div>
  );
}
