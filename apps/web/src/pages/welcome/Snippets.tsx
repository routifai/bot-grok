import { cn } from "@aiden/ui-web";
import type { ReactNode } from "react";

export function WorkingRow({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 text-[13px] text-welcome-ink-2">
      <span className="size-2 animate-[welcomePulse_1.4s_infinite] rounded-full bg-welcome-glow motion-reduce:animate-none" />
      {children}
    </div>
  );
}

// The "asks before it acts" card shared by the hero and the day snippets.
export function Ask({
  className,
  title,
  detail,
  no,
  yes,
}: {
  className?: string;
  title?: string;
  detail?: string;
  no: string;
  yes: string;
}) {
  return (
    <div
      className={cn(
        "grid w-full gap-2.5 rounded-2xl border border-welcome-hair-2 bg-welcome-win-2 p-3.5",
        className,
      )}
    >
      {title && (
        <div className="flex items-center gap-2.5 text-sm font-semibold">
          <i className="grid size-[26px] place-items-center rounded-lg bg-welcome-amber text-[13px] not-italic text-welcome-night">
            ✈
          </i>
          {title}
        </div>
      )}
      {detail && <p className="m-0 text-[13px] leading-[1.45] text-welcome-ink-2">{detail}</p>}
      <div className="grid grid-cols-2 gap-2">
        <span className="rounded-[10px] bg-welcome-bubble p-2 text-center text-[13px] font-semibold text-welcome-ink-2">
          {no}
        </span>
        <span className="rounded-[10px] bg-welcome-ink p-2 text-center text-[13px] font-semibold text-welcome-night">
          {yes}
        </span>
      </div>
    </div>
  );
}
