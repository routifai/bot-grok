import { Check, X } from "lucide-react";

// Tiny, decorative stand-ins built from the same shapes as the real cards they preview —
// a `Surface`-style card, the `Progress` ring, an Ask row's left accent — not stock icons
// (the welcome's three "how it works" cards, `FirstRunWelcome.tsx`). Purely illustrative:
// aria-hidden, no live data, no interaction.

/** Previews a finished result handed back as a card you can accept or ask to redo. */
export function MiniResultIllustration() {
  return (
    <div
      aria-hidden="true"
      className="flex w-full max-w-[132px] flex-col gap-1.5 rounded-xl border border-border bg-card p-2.5 shadow-sm"
    >
      <span className="h-1.5 w-4/5 rounded-full bg-muted-foreground/25" />
      <span className="h-1.5 w-3/5 rounded-full bg-muted-foreground/25" />
      <span className="mt-1 flex items-center gap-1.5">
        <span className="grid size-4 place-items-center rounded-full bg-foreground text-background">
          <Check size={10} strokeWidth={2.5} />
        </span>
        <span className="grid size-4 place-items-center rounded-full border border-border text-muted-foreground">
          <X size={10} strokeWidth={2.5} />
        </span>
      </span>
    </div>
  );
}

/** Previews a Goal's done/total ring (`Progress`, `../ui`: ink on muted, same idea as a ring). */
export function MiniGoalRingIllustration() {
  const radius = 15;
  const circumference = 2 * Math.PI * radius;
  const done = 0.65;
  return (
    <svg aria-hidden="true" viewBox="0 0 36 36" className="size-9">
      <circle cx="18" cy="18" r={radius} fill="none" strokeWidth={4} className="stroke-muted" />
      <circle
        cx="18"
        cy="18"
        r={radius}
        fill="none"
        strokeWidth={4}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - done)}
        transform="rotate(-90 18 18)"
        className="stroke-foreground"
      />
    </svg>
  );
}

/** Previews an open Ask's quiet inbox row (`AskItem.tsx`: warning left edge, icon, one line). */
export function MiniAskRowIllustration() {
  return (
    <div
      aria-hidden="true"
      className="flex w-full max-w-[132px] items-center gap-2 rounded-md border-l-2 border-l-warning bg-card py-1.5 pl-2 pr-2.5"
    >
      <span className="size-3.5 shrink-0 rounded-full bg-muted" />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="h-1.5 w-full rounded-full bg-muted-foreground/25" />
        <span className="h-1.5 w-2/3 rounded-full bg-muted-foreground/15" />
      </span>
    </div>
  );
}
