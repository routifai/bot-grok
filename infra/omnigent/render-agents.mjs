#!/usr/bin/env node
// Renders the two Nova Omnigent agent bundles (docs/omnigent-spike.md) from one shared
// template so the pi and claude-sdk variants differ only in `executor`. Run after editing
// infra/omnigent/templates/config.yaml.tmpl or templates/AGENTS.md:
//
//   node infra/omnigent/render-agents.mjs
//
// No YAML library: the template is plain text with {{PLACEHOLDER}} tokens, substituted with
// simple string replacement, so the output stays byte-for-byte predictable.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** One entry per bundle under infra/omnigent/agents/<dir>/. modelEnv documented in docs/omnigent-spike.md. */
const BUNDLES = [
  { dir: "nova-pi", name: "nova-pi", harness: "pi", modelEnv: "NOVA_PI_MODEL" },
  { dir: "nova-claude", name: "nova-claude", harness: "claude-sdk", modelEnv: "NOVA_CLAUDE_MODEL" },
];

function render(template, values) {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{{${key}}}`, value),
    template,
  );
}

function main() {
  const configTemplate = readFileSync(join(here, "templates/config.yaml.tmpl"), "utf8");
  const agentsMd = readFileSync(join(here, "templates/AGENTS.md"), "utf8");

  for (const bundle of BUNDLES) {
    const outDir = join(here, "agents", bundle.dir);
    const config = render(configTemplate, {
      NAME: bundle.name,
      HARNESS: bundle.harness,
      MODEL_ENV: bundle.modelEnv,
    });
    writeFileSync(join(outDir, "config.yaml"), config);
    writeFileSync(join(outDir, "AGENTS.md"), agentsMd);
    console.log(`wrote ${outDir}/config.yaml and AGENTS.md`);
  }
}

main();
