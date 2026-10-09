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
  "Default to not saving.",
  "`replaces_claim_id`",
  "save its negation",
  // Clarification and follow-ups.
  "`ask_clarification`",
  "only when the request is\n  genuinely ambiguous",
  "`suggest_follow_ups`",
  "Never generic\n  filler",
  // Natural-language schedules.
  "pass those words as the create call's `schedule` argument",
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
