import { describe, expect, it } from "vitest";
import { isMuseMode, resolveProductMode } from "./product-mode.js";

describe("resolveProductMode", () => {
  it("defaults to the Muse edition", () => {
    expect(resolveProductMode({})).toBe("muse");
    expect(resolveProductMode({ AIDEN_PRODUCT_MODE: "" })).toBe("muse");
    expect(resolveProductMode({ AIDEN_PRODUCT_MODE: "muse" })).toBe("muse");
    expect(resolveProductMode({ AIDEN_PRODUCT_MODE: "something-else" })).toBe("muse");
  });

  it("keeps the older multi-bot mode only when asked for explicitly", () => {
    expect(resolveProductMode({ AIDEN_PRODUCT_MODE: "aiden" })).toBe("aiden");
    expect(resolveProductMode({ AIDEN_PRODUCT_MODE: " Aiden " })).toBe("aiden");
  });

  it("answers isMuseMode", () => {
    expect(isMuseMode("muse")).toBe(true);
    expect(isMuseMode("aiden")).toBe(false);
  });
});
