import { useLayoutEffect, useState } from "react";

/** The Conversation never gets narrower than this beside an open panel. */
export const CONVERSATION_MIN_W = 400;
/** The narrowest a panel is worth showing beside the Conversation: a deck (or anything wide) needs
 * room for its slide rail and stage, a plain file less. */
export const PANEL_MIN_W = { wide: 560, plain: 400 } as const;
/** The panel's own inset (`md:m-2` on both sides). */
const PANEL_GUTTER = 16;

export type ArtifactPanelLayout =
  /** Beside the Conversation at this width in px. */
  | { mode: "split"; width: number }
  /** Over the Conversation: the row is too narrow for both. */
  | { mode: "overlay" };

/**
 * Where the artifact panel goes in a row `rowWidth` px wide (the Conversation and the panel
 * together). The panel takes a share of the row (bigger for a wide file, all it can while a deck
 * is edited) up to a cap, but always leaves the Conversation `CONVERSATION_MIN_W`; when that
 * leaves the panel less than its minimum, it becomes a sheet over the Conversation instead of
 * crushing it.
 */
export function artifactPanelLayout(
  rowWidth: number,
  { wide, expanded }: { wide?: boolean; expanded?: boolean },
): ArtifactPanelLayout {
  const min = wide || expanded ? PANEL_MIN_W.wide : PANEL_MIN_W.plain;
  const room = rowWidth - CONVERSATION_MIN_W - PANEL_GUTTER;
  if (room < min) return { mode: "overlay" };
  const [share, cap] = expanded ? [1, 1600] : wide ? [0.6, 960] : [0.46, 640];
  const preferred = Math.min(cap, Math.round((rowWidth - PANEL_GUTTER) * share));
  return { mode: "split", width: Math.max(min, Math.min(preferred, room)) };
}

/** The width of `element`'s parent, kept current; null until measured (or with no layout, as in
 * tests). */
export function useParentWidth(element: HTMLElement | null): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const parent = element?.parentElement;
    if (!parent) return;
    const read = () => {
      const next = parent.getBoundingClientRect().width;
      setWidth(next > 0 ? Math.round(next) : null);
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [element]);
  return width;
}
