import { ChevronRight } from "lucide-react";
import { type ReactNode, useState } from "react";

const STORAGE_KEY = "nova.memory.closedSections";

function readClosed(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function writeClosed(ids: string[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // Storage can be blocked; the section just won't remember its state.
  }
}

/**
 * One collapsible Memory section: a small uppercase label with its count ("ABOUT YOU · 3")
 * over its rows. Open state is remembered per section id in localStorage.
 */
export function MemorySection({
  id,
  title,
  count,
  forceOpen = false,
  children,
}: {
  id: string;
  title: string;
  count?: number;
  /** Stays open while a search is filtering the rows. */
  forceOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(() => !readClosed().includes(id));
  const shown = open || forceOpen;
  const toggle = () => {
    const next = !open;
    setOpen(next);
    const closed = readClosed().filter((closedId) => closedId !== id);
    writeClosed(next ? closed : [...closed, id]);
  };
  return (
    <section className="flex flex-col" data-testid={`memory-section-${id}`}>
      <button
        type="button"
        aria-expanded={shown}
        onClick={toggle}
        className="group/header flex h-7 items-center gap-1 rounded-md px-3 text-left text-[11px] font-medium tracking-wider text-muted-foreground uppercase outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <ChevronRight
          className={`size-3 shrink-0 transition-transform ${shown ? "rotate-90" : ""}`}
          aria-hidden
        />
        <span>{title}</span>
        {count === undefined ? null : <span className="tabular-nums">· {count}</span>}
      </button>
      {shown ? <div className="flex flex-col">{children}</div> : null}
    </section>
  );
}

/** The one muted line an empty section shows. */
export function MemoryEmptyLine({ children }: { children: ReactNode }) {
  return <p className="px-3 py-1 text-[12px] leading-4 text-muted-foreground">{children}</p>;
}
