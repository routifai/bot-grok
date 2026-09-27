import type { ProductMode } from "@aiden/contracts";

/** `AIDEN_PRODUCT_MODE=muse` turns on the single-Muse edition; anything else is upstream Rakazo. */
export function resolveProductMode(source: NodeJS.ProcessEnv = process.env): ProductMode {
  return source.AIDEN_PRODUCT_MODE?.trim().toLowerCase() === "muse" ? "muse" : "aiden";
}

export function isMuseMode(mode: ProductMode): boolean {
  return mode === "muse";
}
