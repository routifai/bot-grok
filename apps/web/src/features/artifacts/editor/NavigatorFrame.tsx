import { Button, cn } from "@superchat/ui-web";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { type ReactNode, useState } from "react";

/** Whether the person folded the navigator away; kept for the session so it survives switching
 * between viewing and editing, and opening another file. */
let collapsedForSession = false;

/**
 * The editor's left column, for any kind's navigator (a deck's slides, a page's layers): its
 * toggle folds it to a slim strip (the kind's `folded` content, e.g. slide numbers) so the stage
 * gets the room; it never floats over the stage.
 */
export function NavigatorFrame({
  label,
  showLabel,
  hideLabel,
  testId,
  folded,
  children,
}: {
  /** The group's accessible name ("Slide rail", "Layers"). */
  label: string;
  showLabel: string;
  hideLabel: string;
  testId?: string;
  /** What the slim strip shows; nothing by default. */
  folded?: ReactNode;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(collapsedForSession);
  const toggle = () => {
    collapsedForSession = !collapsed;
    setCollapsed(!collapsed);
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would be a form group
    <div
      role="group"
      aria-label={label}
      data-testid={testId}
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
          aria-label={collapsed ? showLabel : hideLabel}
          title={collapsed ? showLabel : hideLabel}
          aria-expanded={!collapsed}
          onClick={toggle}
        >
          {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
        </Button>
      </div>
      {collapsed ? (folded ?? null) : children}
    </div>
  );
}

/** Test helper. */
export const resetNavigatorFrame = (): void => {
  collapsedForSession = false;
};
