import type { ProductMode } from "@rakazo/contracts";

const STORAGE_KEY = "rakazo.productMode";

/**
 * Marks the page with the product mode so the Muse palette (`[data-product="muse"]` in
 * `@rakazo/ui-tokens`) applies. Cached so the next load paints in the right palette
 * before `me` arrives.
 */
export function applyProductMode(
  mode: ProductMode | undefined,
  root: HTMLElement | null = typeof document !== "undefined" ? document.documentElement : null,
): void {
  if (!root || !mode) return;
  if (mode === "muse") root.dataset.product = "muse";
  else delete root.dataset.product;
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Storage can be unavailable (private mode); the attribute is enough for this load.
  }
}

export function applyCachedProductMode(): void {
  let cached: string | null = null;
  try {
    cached = localStorage.getItem(STORAGE_KEY);
  } catch {
    return;
  }
  if (cached === "muse" || cached === "rakazo") applyProductMode(cached);
}
