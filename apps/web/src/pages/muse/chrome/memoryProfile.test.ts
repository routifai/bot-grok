import { describe, expect, it } from "vitest";
import { addressMemoryItem, parseMemoryProfile } from "./memoryProfile";

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

describe("addressMemoryItem", () => {
  it.each([
    ["The user's favourite fruit is mango.", "Your favourite fruit is mango."],
    ["User's team is Platform.", "Your team is Platform."],
    ["The user is a relationship manager.", "You are a relationship manager."],
    [
      "This month the user is focused on agent safety and the user's approvals work.",
      "This month you're focused on agent safety and your approvals work.",
    ],
    ["The user has two direct reports.", "You have two direct reports."],
    ["The user prefers short answers.", "You prefer short answers."],
    ["The user doesn't like long emails.", "You don't like long emails."],
    ["The user watches the markets daily.", "You watch the markets daily."],
    ["Lives in Toronto.", "Lives in Toronto."],
    ["The username is sam.", "The username is sam."],
    ["The user is a PM and is a product manager.", "You are a PM and are a product manager."],
    [
      "The user is building an AI assistant and is a product manager.",
      "You are building an AI assistant and are a product manager.",
    ],
  ])("%s", (input, expected) => {
    expect(addressMemoryItem(input)).toBe(expected);
  });
});
