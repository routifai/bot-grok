import { describe, expect, it } from "vitest";
import { isMuseMode, resolveProductMode } from "./product-mode.js";

describe("resolveProductMode", () => {
  it("defaults to upstream Rakazo", () => {
    expect(resolveProductMode({})).toBe("rakazo");
    expect(resolveProductMode({ RAKAZO_PRODUCT_MODE: "" })).toBe("rakazo");
    expect(resolveProductMode({ RAKAZO_PRODUCT_MODE: "something-else" })).toBe("rakazo");
  });

  it("turns on the Muse edition", () => {
    expect(resolveProductMode({ RAKAZO_PRODUCT_MODE: "muse" })).toBe("muse");
    expect(resolveProductMode({ RAKAZO_PRODUCT_MODE: " Muse " })).toBe("muse");
  });

  it("answers isMuseMode", () => {
    expect(isMuseMode("muse")).toBe(true);
    expect(isMuseMode("rakazo")).toBe(false);
  });
});
