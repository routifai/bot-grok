import { useLingui } from "@lingui/react/macro";
import { Button, cn } from "@superchat/ui-web";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useState } from "react";
import { DeckThumb } from "./DeckThumb";
import type { DeckSlide } from "./deck-model";

/** Whether the person folded the rail away; kept for the session so it survives switching
 * between viewing and editing, and opening another deck. */
let collapsedForSession = false;

/**
 * The slide rail beside the stage: a column of same-size 16:9 live thumbnails, each with its
 * number, the current one outlined. The toggle folds it to a slim strip of slide numbers so the
 * stage gets the room; it never floats over the slide.
 */
export function DeckRail({
  html,
  slides,
  active,
  onSelect,
}: {
  html: string;
  slides: readonly DeckSlide[];
  active: number;
  onSelect: (index: number) => void;
}) {
  const { t } = useLingui();
  const [collapsed, setCollapsed] = useState(collapsedForSession);
  const toggle = () => {
    collapsedForSession = !collapsed;
    setCollapsed(!collapsed);
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would be a form group
    <div
      role="group"
      aria-label={t`Slide rail`}
      data-testid="deck-rail"
      data-collapsed={collapsed ? "true" : undefined}
      className={cn(
        "flex shrink-0 flex-col overflow-hidden border-e border-border",
        "motion-safe:transition-[width] motion-safe:duration-200 motion-safe:ease-out",
        collapsed ? "w-12" : "w-[164px]",
      )}
    >
      <div className={cn("flex shrink-0 px-2 pt-2", collapsed ? "justify-center" : "justify-end")}>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground"
          aria-label={collapsed ? t`Show slides` : t`Hide slides`}
          title={collapsed ? t`Show slides` : t`Hide slides`}
          aria-expanded={!collapsed}
          onClick={toggle}
        >
          {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
        </Button>
      </div>
      <div
        role="listbox"
        aria-label={t`Slides`}
        aria-orientation="vertical"
        className={cn(
          "flex min-h-0 flex-1 flex-col overflow-y-auto",
          collapsed ? "items-center gap-1 px-1.5 py-2" : "gap-1 px-1.5 pt-1 pb-3",
        )}
      >
        {slides.map((slide) =>
          collapsed ? (
            <button
              key={slide.index}
              type="button"
              role="option"
              aria-selected={slide.index === active}
              aria-current={slide.index === active ? "true" : undefined}
              aria-label={slide.label || String(slide.index + 1)}
              title={slide.label.replace(/^\d+\s*/, "") || undefined}
              onClick={() => onSelect(slide.index)}
              className={cn(
                "grid size-8 shrink-0 place-items-center rounded-lg text-[12px] tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring",
                slide.index === active
                  ? "bg-foreground font-semibold text-background"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {slide.index + 1}
            </button>
          ) : (
            <DeckThumb
              key={slide.index}
              html={html}
              index={slide.index}
              label={slide.label}
              active={slide.index === active}
              onSelect={onSelect}
            />
          ),
        )}
      </div>
    </div>
  );
}

/** Test helper. */
export const resetDeckRail = (): void => {
  collapsedForSession = false;
};
