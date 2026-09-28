import { cn } from "@aiden/ui-web";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { MUSE_INSET_GROUP } from "../ui";

/**
 * iOS-style settings pieces: an inset group of rows with hairline dividers, a quiet caption
 * above and an explanation below. Every Settings section is built from these, so they all
 * read like the Nova section.
 */
export function SettingsGroup({
  title,
  footer,
  children,
}: {
  title?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section>
      {title ? (
        <h3 className="px-4 pb-2 text-[13.5px] font-medium text-muted-foreground">{title}</h3>
      ) : null}
      <div className={cn(MUSE_INSET_GROUP, "divide-y divide-border/70")}>{children}</div>
      {footer ? <p className="px-4 pt-2 text-[13px] text-muted-foreground">{footer}</p> : null}
    </section>
  );
}

export const SETTINGS_ROW = "flex min-h-[52px] w-full items-center justify-between gap-4 px-4";

/** A label on the left and a value (or control) on the right. */
export function SettingsRow({
  label,
  value,
  children,
}: {
  label: ReactNode;
  value?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={SETTINGS_ROW}>
      <span className="min-w-0 truncate text-[16px] text-foreground">{label}</span>
      {value !== undefined ? (
        <span className="min-w-0 truncate text-[15px] text-muted-foreground">{value}</span>
      ) : null}
      {children}
    </div>
  );
}

/** A row that opens something: a chevron, the whole row tappable. */
export function SettingsLinkRow({
  label,
  value,
  onClick,
  expanded,
}: {
  label: ReactNode;
  value?: ReactNode;
  onClick: () => void;
  /** For rows that expand in place rather than navigate. */
  expanded?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={expanded}
      className={cn(
        SETTINGS_ROW,
        "group text-start transition-colors hover:bg-accent/50 active:bg-accent",
      )}
    >
      <span className="min-w-0 truncate text-[16px] text-foreground">{label}</span>
      <span className="flex min-w-0 items-center gap-1.5 text-[15px] text-muted-foreground">
        {value ? <span className="truncate">{value}</span> : null}
        <ChevronRight
          size={17}
          strokeWidth={2}
          aria-hidden="true"
          className={cn(
            "shrink-0 text-muted-foreground/60 transition-transform",
            expanded ? "rotate-90" : "group-hover:translate-x-0.5",
          )}
        />
      </span>
    </button>
  );
}

/** A pill segmented control, same as the Nova section's "Working on its own". */
export function SettingsSegmented<T extends string>({
  label,
  options,
  value,
  onChange,
  testId,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (next: T) => void;
  testId?: string;
}) {
  return (
    <div className="p-1.5">
      <fieldset
        aria-label={label}
        data-testid={testId}
        className="grid gap-1 rounded-[16px] bg-muted p-1"
        style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
      >
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={selected}
              data-testid={testId ? `${testId}-${option.value}` : undefined}
              onClick={() => {
                if (!selected) onChange(option.value);
              }}
              className={cn(
                "rounded-[12px] py-2 text-[14.5px] font-medium transition-[background-color,box-shadow,color] duration-200",
                selected
                  ? "bg-card text-foreground shadow-[0_1px_3px_rgb(0_0_0/0.12)]"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {option.label}
            </button>
          );
        })}
      </fieldset>
    </div>
  );
}
