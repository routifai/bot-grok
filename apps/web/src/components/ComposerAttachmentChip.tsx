import { MousePointerClick, Table2 } from "lucide-react";
import type { ReactNode } from "react";

const ICONS = { sheet: Table2, deck: MousePointerClick } as const;
const TEST_IDS = { sheet: "sheet-ask-chip", deck: "deck-ask-chip" } as const;

/** The compact chip for something attached to a message ("Sales!C2:C8 · 7 cells", "Slide 2 ·
 * Heading"): in the composer (with a remove button) and in the transcript above a sent message. */
export function ComposerAttachmentChip({
  kind,
  label,
  children,
  testId,
  className = "",
}: {
  kind: string;
  label: string;
  children?: ReactNode;
  testId?: string;
  className?: string;
}) {
  const Icon = ICONS[kind as keyof typeof ICONS] ?? Table2;
  return (
    <div
      data-testid={testId ?? TEST_IDS[kind as keyof typeof TEST_IDS] ?? "composer-attachment-chip"}
      className={`flex w-fit max-w-full items-center gap-2 rounded-full border border-border bg-muted px-3 py-1.5 text-[13px] text-foreground/75 ${className}`}
    >
      <Icon size={14} strokeWidth={1.8} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {children}
    </div>
  );
}
