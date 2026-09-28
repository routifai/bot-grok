import type { ProductMode } from "@aiden/contracts";

/**
 * Aiden's single-Muse edition is the product. `AIDEN_PRODUCT_MODE=aiden` still selects the older
 * multi-bot mode until it is removed; anything else, including unset, is the Muse edition.
 */
export function resolveProductMode(source: NodeJS.ProcessEnv = process.env): ProductMode {
  return source.AIDEN_PRODUCT_MODE?.trim().toLowerCase() === "aiden" ? "aiden" : "muse";
}

export function isMuseMode(mode: ProductMode): boolean {
  return mode === "muse";
}
