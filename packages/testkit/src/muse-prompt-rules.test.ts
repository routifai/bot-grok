// The Muse's prompt rules for memory, clarification, follow-ups and scheduling live in one
// template (infra/omnigent/templates/AGENTS.md) and are rendered into each bundle by
// `node infra/omnigent/render-agents.mjs`. This fails when a rule is dropped or a bundle was
// not re-rendered after the template changed.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../infra/omnigent/", import.meta.url));
const read = (path: string) => readFileSync(`${root}${path}`, "utf8");

const rules = [
  // Memory: two bars, permanence signals, supersede, default to nothing.
  "**Profile facts**",
  "**Standing instructions**",
  "permanence signal",
  "`replaces_claim_id`",
  // Clarification and follow-ups.
  "`ask_clarification`",
  "only when the request is\n  genuinely ambiguous",
  "`suggest_follow_ups`",
  "never `render_card`",
  "never approval for an\n  action in their name",
  "Never generic\n  filler",
  // Recurring tasks: the Muse writes the rule, confirms the concrete times, asks when unsure.
  "write the `rrule` yourself",
  "`next_fire_times`",
  "Never guess silently",
  "For a followed topic only, never ask about day",
  // Memory: profile facts always saved, instructions gated, no stored negation.
  "Always save them",
  "never store a negation",
  '`explicitness: "inferred"`',
];

describe("Muse prompt rules", () => {
  it.each(["templates/AGENTS.md", "agents/nova-claude/AGENTS.md", "agents/nova-pi/AGENTS.md"])(
    "%s carries every rule",
    (path) => {
      const text = read(path);
      for (const rule of rules) expect(text, rule).toContain(rule);
    },
  );

  it("keeps Nova's memory kinds and portrait evidence tools", () => {
    const text = read("templates/AGENTS.md");
    for (const kind of ["fact", "project", "preference", "instruction", "decision", "commitment"]) {
      expect(text).toContain(`\`${kind}\``);
    }
    expect(text).toContain("`memory_search`");
  });

  it.each(["agents/nova-claude/config.yaml", "agents/nova-pi/config.yaml"])(
    "%s allows both card tools",
    (path) => {
      const text = read(path);
      expect(text).toContain("- ask_clarification");
      expect(text).toContain("- suggest_follow_ups");
    },
  );
});

describe("Muse deck theme choice", () => {
  const deckRules = [
    "A NEW deck always starts by asking for its look, unless the look is already settled",
    "not an earlier deck in this Conversation, not a deck with a similar name",
    '"Make a deck from it", "now a 5-slide deck", "turn this into slides" are NEW decks',
    "Only redoing, fixing or extending the SAME deck file keeps its theme",
    "`deck_new` takes `look_from`",
    "It checks this against the conversation",
    'call `deck_new` with `look_from: "ask"`',
    "The card ends your turn",
    "Settle the look BEFORE handing deck work to a Helper",
    "a Helper never picks a look",
    "never re-offer looks the person already passed over",
    "not a remembered taste or preference (it may only shape which 3 looks you offer and their order)",
    "leaving its current theme out",
    '"kind": "deck-theme"',
    "do not ask again",
    "never ask then",
    "three different categories and moods",
    "Never offer two themes of the same category and mode",
    "Asking ends your turn",
    "exactly that theme, never another one",
  ];
  it.each(["templates/decks.md", "agents/nova-claude/AGENTS.md", "agents/nova-pi/AGENTS.md"])(
    "%s asks for the look of every new deck before building it",
    (path) => {
      const text = read(path).replace(/\s+/g, " ");
      for (const rule of deckRules) expect(text, rule).toContain(rule);
      // A default theme never stands in for the person's choice.
      expect(text).not.toContain("Default to a restrained professional theme");
      expect(text).not.toContain("although a default exists");
      // The ask comes before the theme dictionary, so it is read first.
      expect(text.indexOf("A NEW deck always starts by asking")).toBeLessThan(
        text.indexOf("Choosing a theme yourself"),
      );
    },
  );
});

describe("Muse dashboard rules", () => {
  const dashboardRules = [
    "Chart the person's file directly: never pre-aggregate into a scratch copy",
    '`"agg": "mean", "weight": "revenue"` is a weighted average',
    "a combo's line has its own `agg2`",
    '`"names": {"margin_pct": "Gross margin"}`',
    "The page cites each source by its path in the workspace",
    "do not say whether you opened, viewed or checked the page",
    "Pass the spec (JSON) on stdin, so no spec file is left to clean up",
    "Never write a spec or other scratch file into `your_files/`",
    "never delete your own temp files",
  ];
  it.each(["templates/AGENTS.md", "agents/nova-claude/AGENTS.md", "agents/nova-pi/AGENTS.md"])(
    "%s keeps dashboards citing the person's files",
    (path) => {
      const text = read(path).replace(/\s+/g, " ");
      for (const rule of dashboardRules) expect(text, rule).toContain(rule);
    },
  );
});
