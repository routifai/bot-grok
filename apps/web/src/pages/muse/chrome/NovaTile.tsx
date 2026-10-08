import { cn } from "@nova/ui-web";
import type { ReactNode } from "react";

export type TileTone =
  | "blue"
  | "green"
  | "yellow"
  | "orange"
  | "purple"
  | "red"
  | "indigo"
  | "teal"
  | "gray";

/** A colored app tile (docs/muse/DESIGN.md "Tiles"): a rounded square with a soft gradient
 * (`tile-*` tokens, `.nova-tile` in styles.css) and a white glyph. */
export function NovaTile({
  tone,
  size = 28,
  className,
  children,
}: {
  tone: TileTone;
  size?: number;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      aria-hidden="true"
      data-tone={tone}
      className={cn("nova-tile", className)}
      style={{ width: size, height: size }}
    >
      {children}
    </span>
  );
}
