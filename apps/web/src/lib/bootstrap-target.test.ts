import { describe, expect, it } from "vitest";
import { isBootstrapRoute } from "./bootstrap-target";

describe("bootstrap route", () => {
  it("primes the Electron root before its client-side redirect", () => {
    expect(isBootstrapRoute("/", true)).toBe(true);
    expect(isBootstrapRoute("/", false)).toBe(false);
  });

  it("primes browser app routes", () => {
    expect(isBootstrapRoute("/app", false)).toBe(true);
    expect(isBootstrapRoute("/app/some-muse", false)).toBe(true);
    expect(isBootstrapRoute("/app/artifacts/abc", false)).toBe(true);
  });

  it("does not prime unrelated routes", () => {
    expect(isBootstrapRoute("/application", false)).toBe(false);
  });
});
