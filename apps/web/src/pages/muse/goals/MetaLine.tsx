import type { ReactNode } from "react";

/** A row of meta facts (due date, check-in schedule, …) joined by quiet middots. */
export function MetaLine({ items }: { items: ReactNode[] }) {
  const visible = items.filter((item) => item !== null && item !== undefined && item !== "");
  if (visible.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted-foreground">
      {visible.map((item, index) => (
        <span key={index} className="inline-flex items-center gap-2">
          {index > 0 ? (
            <span aria-hidden="true" className="text-muted-foreground/40">
              ·
            </span>
          ) : null}
          {item}
        </span>
      ))}
    </span>
  );
}
