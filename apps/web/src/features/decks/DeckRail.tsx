import { useLingui } from "@lingui/react/macro";
import { Button, cn } from "@nova/ui-web";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useState } from "react";
import { DeckThumb } from "./DeckThumb";
import type { DeckSlide } from "./deck-model";

/** The slim strip and the opened drawer, in px (the drawer opens over the stage). */
export const RAIL_SLIM_W = 60;
export const RAIL_OPEN_W = 148;

/**
 * The slide rail. In view mode it is a plain column of thumbnails. In edit mode it is a slim strip
 * of small thumbnails that takes almost no room; hovering it, focusing into it or pressing the
 * toggle opens the full rail over the stage (it floats, so the slide never moves).
 */
export function DeckRail({
  html,
  slides,
  active,
  onSelect,
  slim,
}: {
  html: string;
  slides: readonly DeckSlide[];
  active: number;
  onSelect: (index: number) => void;
  slim: boolean;
}) {
  const { t } = useLingui();
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [pinned, setPinned] = useState(false);
  const open = slim && (hover || focus || pinned);
  const compact = slim && !open;

  return (
    <div
      className={cn(
        "relative shrink-0 motion-safe:transition-[width] motion-safe:duration-300 motion-safe:ease-out",
        slim ? "z-20 w-[60px]" : "w-[148px]",
      )}
    >
      {/* Hover only widens the rail; keyboard and touch use the focus and the toggle button. */}
      {/* biome-ignore lint/a11y/useSemanticElements: a fieldset would be a form group */}
      <div
        role="group"
        aria-label={t`Slide rail`}
        data-testid="deck-rail"
        data-slim={slim ? "true" : undefined}
        data-open={open ? "true" : undefined}
        onMouseEnter={slim ? () => setHover(true) : undefined}
        onMouseLeave={slim ? () => setHover(false) : undefined}
        onFocus={slim ? () => setFocus(true) : undefined}
        onBlur={
          slim
            ? (event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) setFocus(false);
              }
            : undefined
        }
        className={cn(
          "absolute inset-y-0 start-0 flex flex-col overflow-hidden border-e border-border bg-background",
          "motion-safe:transition-[width,background-color,box-shadow] motion-safe:duration-200 motion-safe:ease-out",
          slim ? (open ? "w-[148px]" : "w-[60px]") : "w-[148px]",
          open &&
            "rounded-e-2xl border-transparent bg-popover shadow-[0_8px_32px_rgb(0_0_0/0.14)] ring-1 ring-border",
        )}
      >
        {slim ? (
          <div
            className={cn("flex shrink-0 px-2 pt-2 pb-1", open ? "justify-end" : "justify-center")}
          >
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground"
              aria-label={pinned ? t`Collapse slides` : t`Expand slides`}
              aria-expanded={open}
              onClick={(event) => {
                // Collapsing closes the rail even under the pointer; hovering again reopens it.
                if (open && pinned) {
                  setHover(false);
                  setFocus(false);
                  event.currentTarget.blur();
                }
                setPinned((value) => !value);
              }}
            >
              {pinned ? <PanelLeftClose /> : <PanelLeftOpen />}
            </Button>
          </div>
        ) : null}
        <div
          role="listbox"
          aria-label={t`Slides`}
          aria-orientation="vertical"
          className={cn(
            "flex min-h-0 flex-1 flex-col overflow-y-auto",
            compact ? "items-center gap-2 px-2 pt-1 pb-3" : "gap-3 px-4 py-3",
            slim && !compact && "pt-1",
          )}
        >
          {slides.map((slide) => (
            <DeckThumb
              key={slide.index}
              html={html}
              index={slide.index}
              label={slide.label}
              active={slide.index === active}
              compact={compact}
              onSelect={onSelect}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
