import type { ProductMode } from "@rakazo/contracts";

/** `RAKAZO_PRODUCT_MODE=muse` turns on the single-Muse edition; anything else is upstream Rakazo. */
export function resolveProductMode(source: NodeJS.ProcessEnv = process.env): ProductMode {
  return source.RAKAZO_PRODUCT_MODE?.trim().toLowerCase() === "muse" ? "muse" : "rakazo";
}

export function isMuseMode(mode: ProductMode): boolean {
  return mode === "muse";
}
