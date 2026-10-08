import { GROK_COLOR_LIST, resolvePersonaColorDef } from "@nova/core";

/**
 * Nova Canvas reuses the app's existing identity-color set (the same hues bots use for
 * their avatars) for anything that needs to tell categories apart — item-card monograms and
 * multi-series charts — rather than inventing new product colors. A single-series chart
 * stays monochrome ink, matching the rest of the UI.
 */
const CHART_PALETTE = GROK_COLOR_LIST.filter((color) => color.id !== "white").map(
  (color) => color.hex,
);

export function seriesColor(index: number, seriesCount: number): string | undefined {
  // One series: no color needed, callers fall back to currentColor (ink).
  if (seriesCount <= 1) return undefined;
  return CHART_PALETTE[index % CHART_PALETTE.length];
}

export function monogramColor(identity: string, explicit?: string): string {
  return resolvePersonaColorDef(identity, explicit ?? null).hex;
}

export function initials(title: string): string {
  const words = title.trim().split(/\s+/).filter(Boolean);
  return (
    words
      .slice(0, 2)
      .map((word) => word[0]?.toUpperCase() ?? "")
      .join("") || "?"
  );
}
