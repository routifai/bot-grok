import { useLingui } from "@lingui/react/macro";
import { cn } from "@nova/ui-web";
import type { ComputerView } from "./useComputerView";

/** Screen | Files, a quiet segmented control for the Computer panel header. */
export function ComputerViewSwitch({
  value,
  onChange,
}: {
  value: ComputerView;
  onChange: (next: ComputerView) => void;
}) {
  const { t } = useLingui();
  const options: Array<{ id: ComputerView; label: string }> = [
    { id: "screen", label: t`Screen` },
    { id: "files", label: t`Files` },
  ];
  return (
    <div
      role="tablist"
      aria-label={t`Computer view`}
      className="inline-flex rounded-full border border-border bg-muted/60 p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="tab"
          aria-selected={value === option.id}
          onClick={() => onChange(option.id)}
          className={cn(
            "rounded-full px-3 py-1 text-[13px] transition-colors",
            value === option.id
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
