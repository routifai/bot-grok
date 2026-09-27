// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applyCachedProductMode, applyProductMode } from "./product-mode";

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
  });
});

afterEach(() => {
  delete document.documentElement.dataset.product;
  vi.unstubAllGlobals();
});

it("marks the page in muse mode and clears it otherwise", () => {
  applyProductMode("muse");
  expect(document.documentElement.dataset.product).toBe("muse");
  applyProductMode("rakazo");
  expect(document.documentElement.dataset.product).toBeUndefined();
});

it("reapplies the cached mode on the next load", () => {
  applyProductMode("muse");
  delete document.documentElement.dataset.product;
  applyCachedProductMode();
  expect(document.documentElement.dataset.product).toBe("muse");
});
