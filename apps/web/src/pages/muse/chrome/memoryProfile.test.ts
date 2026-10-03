import { expect, it } from "vitest";
import { parseMemoryProfile } from "./memoryProfile";

const SAMPLE = [
  "[Standing memory about the user — provided by the system, not a message from the user]",
  "",
  "Preferences:",
  "- Prefers phone-first slide decks",
  "- Weekly summaries on Mondays",
  "About the user:",
  "- Works branch operations at a bank",
  "",
  "[End of standing memory]",
].join("\n");

it("drops the bracketed framing lines", () => {
  const sections = parseMemoryProfile(SAMPLE);
  const text = sections.flatMap((section) => [section.heading, ...section.items]).join(" ");
  expect(text).not.toContain("[");
  expect(text).not.toContain("]");
});

it("groups bullet items under their heading, in order", () => {
  const sections = parseMemoryProfile(SAMPLE);
  expect(sections).toEqual([
    {
      heading: "Preferences",
      items: ["Prefers phone-first slide decks", "Weekly summaries on Mondays"],
    },
    { heading: "About the user", items: ["Works branch operations at a bank"] },
  ]);
});

it("returns an empty list for null, undefined, or blank input", () => {
  expect(parseMemoryProfile(null)).toEqual([]);
  expect(parseMemoryProfile(undefined)).toEqual([]);
  expect(parseMemoryProfile("   \n  ")).toEqual([]);
});

it("keeps stray bullet items under an empty heading instead of dropping them", () => {
  const sections = parseMemoryProfile("- A note with no heading above it");
  expect(sections).toEqual([{ heading: "", items: ["A note with no heading above it"] }]);
});

it("drops an empty section (a heading with no items under it)", () => {
  const sections = parseMemoryProfile("Preferences:\nAbout the user:\n- Works at a bank");
  expect(sections).toEqual([{ heading: "About the user", items: ["Works at a bank"] }]);
});
