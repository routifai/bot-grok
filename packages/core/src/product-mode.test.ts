import { describe, expect, it } from "vitest";
import { isMuseMode, resolveProductMode } from "./product-mode.js";

describe("resolveProductMode", () => {
  it("defaults to the full Aiden mode", () => {
    expect(resolveProductMode({})).toBe("aiden");
    expect(resolveProductMode({ AIDEN_PRODUCT_MODE: "" })).toBe("aiden");
    expect(resolveProductMode({ AIDEN_PRODUCT_MODE: "something-else" })).toBe("aiden");
  });

  it("turns on the Muse edition", () => {
    expect(resolveProductMode({ AIDEN_PRODUCT_MODE: "muse" })).toBe("muse");
    expect(resolveProductMode({ AIDEN_PRODUCT_MODE: " Muse " })).toBe("muse");
  });

  it("answers isMuseMode", () => {
    expect(isMuseMode("muse")).toBe(true);
    expect(isMuseMode("aiden")).toBe(false);
  });
});
