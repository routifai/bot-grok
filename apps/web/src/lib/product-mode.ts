import type { ProductMode } from "@aiden/contracts";
import { useEffect, useState } from "react";

const STORAGE_KEY = "aiden.productMode";

/**
 * Marks the page with the product mode so the Muse palette (`[data-product="muse"]` in
 * `@aiden/ui-tokens`) applies. Cached so the next load paints in the right palette
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
  if (cached === "muse" || cached === "aiden") applyProductMode(cached);
}

/**
 * The product mode for pages shown before sign-in, which have no `me` yet. Starts from
 * the cached mode (or the page attribute) and confirms it with the public `/api/product`.
 */
export function useProductMode(): ProductMode {
  const [mode, setMode] = useState<ProductMode>(() =>
    typeof document !== "undefined" && document.documentElement.dataset.product === "muse"
      ? "muse"
      : "aiden",
  );
  useEffect(() => {
    let active = true;
    void fetch("/api/product")
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { productMode?: unknown } | null) => {
        const next = body?.productMode === "muse" ? "muse" : "aiden";
        if (!active) return;
        applyProductMode(next);
        setMode(next);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  return mode;
}
