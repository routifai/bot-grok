/**
 * Marks the page for the Muse palette (`[data-product="muse"]` in `@aiden/ui-tokens`).
 * Muse is Aiden's only edition, so this is unconditional: no fetch, no per-viewer cache.
 */
export function applyMuseProductMode(
  root: HTMLElement | null = typeof document !== "undefined" ? document.documentElement : null,
): void {
  if (!root) return;
  root.dataset.product = "muse";
}
