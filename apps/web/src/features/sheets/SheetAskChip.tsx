import { Table2 } from "lucide-react";
import type { ReactNode } from "react";

/** The compact "Sales!C2:C8 · 7 cells" chip: in the composer (with a remove button) and in the
 * transcript above a sent message. */
export function SheetAskChip({
  label,
  children,
  testId = "sheet-ask-chip",
  className = "",
}: {
  label: string;
  children?: ReactNode;
  testId?: string;
  className?: string;
}) {
  return (
    <div
      data-testid={testId}
      className={`flex w-fit max-w-full items-center gap-2 rounded-full border border-border bg-muted px-3 py-1.5 text-[13px] text-foreground/75 ${className}`}
    >
      <Table2 size={14} strokeWidth={1.8} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {children}
    </div>
  );
}
