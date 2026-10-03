#!/usr/bin/env node
// Renders Nova's single Omnigent Super Chat bundle (`nova-claude`,
// docs/super-chat/WIRING.md slice A1) from the templates under infra/omnigent/templates/, so
// the prompt, config and Sub-agent Types stay generated rather than hand-edited. Run after
// editing anything under templates/:
//
//   node infra/omnigent/render-agents.mjs
//
// No YAML library: every template is plain text with {{PLACEHOLDER}} tokens, substituted with
// simple string replacement, so the output stays byte-for-byte predictable.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(here, "agents/nova-claude");
/** Env var naming documented in docs/omnigent-spike.md / docs/super-chat/README.md. */
const MODEL_ENV = "NOVA_CLAUDE_MODEL";
/** One directory per Sub-agent Type (CONTEXT.md), each a static config.yaml — no templated
 * values inside them today, but rendered (not just copied) so a future per-type placeholder
 * does not require restructuring this script. */
const SUB_AGENT_TYPES = ["researcher", "analyst", "drafter"];
const GENERATED_HEADER =
  "# GENERATED FILE — do not edit by hand. Edit the matching file under\n" +
  "# infra/omnigent/templates/, then run `node infra/omnigent/render-agents.mjs`.\n\n";

function render(template, values) {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{{${key}}}`, value),
    template,
  );
}

function main() {
  const configTemplate = readFileSync(join(here, "templates/config.yaml.tmpl"), "utf8");
  const agentsMd = readFileSync(join(here, "templates/AGENTS.md"), "utf8");

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "config.yaml"), render(configTemplate, { MODEL_ENV }));
  writeFileSync(join(OUT_DIR, "AGENTS.md"), agentsMd);
  console.log(`wrote ${OUT_DIR}/config.yaml and AGENTS.md`);

  for (const type of SUB_AGENT_TYPES) {
    const subTemplate = readFileSync(join(here, `templates/agents/${type}/config.yaml`), "utf8");
    const subDir = join(OUT_DIR, "agents", type);
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, "config.yaml"), GENERATED_HEADER + render(subTemplate, {}));
    console.log(`wrote ${subDir}/config.yaml`);
  }
}

main();
