import type { EngineHarness, NovaHarnessId } from "@aiden/contracts";
import { cn, Popover, PopoverContent, PopoverTrigger } from "@aiden/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { Check, ChevronDown } from "lucide-react";
import { useState } from "react";
import { HarnessLogo, HarnessTile } from "./HarnessLogo";
import { useEngine } from "./useEngine";

/**
 * The composer's engine pill: shows which harness Nova is running on, and opens a sheet to
 * switch. Hidden entirely unless the Omnigent engine is on.
 */
export function HarnessPicker({ botId, disabled }: { botId: string; disabled?: boolean }) {
  const { t } = useLingui();
  const { info, choose, switching, error } = useEngine(botId);
  const [open, setOpen] = useState(false);
  if (!info?.enabled || !info.active) return null;
  const active = info.harnesses.find((harness) => harness.id === info.active);
  if (!active) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled}
        aria-label={t`Engine: ${active.name}. Change engine`}
        data-testid="harness-pill"
        className={cn(
          "group flex h-8 shrink-0 items-center gap-1.5 rounded-full ps-1.5 pe-2 text-[13.5px] font-medium text-foreground/80",
          "bg-muted/60 transition-[background-color,transform] duration-150 hover:bg-muted active:scale-[0.97]",
          "outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40",
          "data-[popup-open]:bg-muted",
        )}
      >
        <span className="grid size-5 place-items-center">
          <HarnessLogo id={active.id} size={active.id === "pi" ? 20 : 15} />
        </span>
        <span className="max-sm:hidden">{active.name}</span>
        <ChevronDown
          size={14}
          strokeWidth={2.25}
          aria-hidden="true"
          className="text-muted-foreground transition-transform duration-200 group-data-[popup-open]:rotate-180"
        />
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={10}
        className="w-[min(360px,calc(100vw-2rem))] rounded-[24px] border-0 bg-popover/95 p-2 shadow-[0_24px_60px_-20px_rgb(0_0_0/0.35),0_2px_6px_rgb(0_0_0/0.06)] ring-1 ring-border/60 backdrop-blur-xl"
      >
        <div className="px-3 pt-2 pb-2.5">
          <p className="text-[15px] font-semibold tracking-[-0.01em] text-foreground">
            <Trans>Engine</Trans>
          </p>
          <p className="mt-0.5 text-[13px] leading-[1.4] text-muted-foreground">
            <Trans>Same Nova, same memory. Pick what runs it.</Trans>
          </p>
        </div>
        <ul className="flex flex-col gap-0.5" data-testid="harness-list">
          {info.harnesses.map((harness) => (
            <HarnessRow
              key={harness.id}
              harness={harness}
              active={harness.id === info.active}
              busy={switching === harness.id}
              onPick={(id) => {
                void choose(id);
                setOpen(false);
              }}
            />
          ))}
        </ul>
        {error ? (
          <p role="alert" className="px-3 pt-2 text-[13px] text-destructive">
            {error}
          </p>
        ) : null}
        <p className="px-3 pt-2.5 pb-1.5 text-[12.5px] text-muted-foreground">
          <Trans>Your next message starts on the new engine.</Trans>
        </p>
      </PopoverContent>
    </Popover>
  );
}

function HarnessRow({
  harness,
  active,
  busy,
  onPick,
}: {
  harness: EngineHarness;
  active: boolean;
  busy: boolean;
  onPick: (id: NovaHarnessId) => void;
}) {
  return (
    <li>
      <button
        type="button"
        disabled={!harness.available || busy}
        aria-pressed={active}
        data-testid={`harness-${harness.id}`}
        onClick={() => onPick(harness.id)}
        className={cn(
          "flex w-full items-center gap-3 rounded-[16px] px-2.5 py-2 text-start transition-colors",
          "outline-none focus-visible:ring-2 focus-visible:ring-ring",
          active ? "bg-accent" : "hover:bg-accent/60",
          !harness.available && "cursor-default hover:bg-transparent",
        )}
      >
        <HarnessTile
          id={harness.id}
          size={38}
          className={harness.available ? undefined : "opacity-40 grayscale"}
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span
              className={cn(
                "text-[15px] font-medium tracking-[-0.01em]",
                harness.available ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {harness.name}
            </span>
            <span className="truncate text-[12.5px] text-muted-foreground">{harness.maker}</span>
          </span>
          <span className="mt-0.5 block text-[13px] leading-[1.35] text-muted-foreground">
            {harness.available ? harness.description : harness.unavailableReason}
          </span>
        </span>
        {active ? (
          <span className="grid size-6 shrink-0 place-items-center rounded-full bg-foreground text-background">
            <Check size={14} strokeWidth={3} aria-hidden="true" />
          </span>
        ) : null}
      </button>
    </li>
  );
}
