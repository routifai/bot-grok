import { describe, expect, it } from "vitest";
import { deriveStatusPill } from "./statusPill";

describe("deriveStatusPill", () => {
  it("shows a 'Needs you' attention pill while waiting", () => {
    expect(deriveStatusPill("waiting")).toEqual({ tone: "attention", text: "Needs you" });
  });

  it("shows no pill while idle — the header is just the title", () => {
    expect(deriveStatusPill("idle")).toBeNull();
  });

  it("shows no pill while thinking or working — those render inline instead", () => {
    expect(deriveStatusPill("thinking")).toBeNull();
    expect(deriveStatusPill("working")).toBeNull();
  });
});
