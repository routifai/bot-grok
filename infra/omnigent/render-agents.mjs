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
/** Where bundles are written; `NOVA_RENDER_AGENTS_DIR` redirects it (tests render to a temp dir). */
// biome-ignore lint/suspicious/noUndeclaredEnvVars: a test-only redirect, not a build input
const AGENTS_DIR = process.env.NOVA_RENDER_AGENTS_DIR || join(here, "agents");
/** One entry per Muse bundle. The engine's `OMNIGENT_SUPERCHAT_DEFAULT_AGENT` (`nova-claude` |
 * `nova-pi`) picks which one a new Muse runs on (ADR 0009): this script renders BOTH every run
 * from the same templates. The choice is total: every Sub-agent Type (worker, subworker, goal,
 * teacher) of a bundle runs on that bundle's harness, so the Muse, its Helpers and
 * scheduled/background Helper runs all share one harness. Pi's extra keys keep it from fighting Omnigent: no AGENTS.md/CLAUDE.md
 * auto-discovery, our prompt replaces pi's base prompt, no host skills; they are defined once
 * here and rendered into the Muse and every Sub-agent Type alike. (Compaction is switched off
 * engine-side, in inner/pi_executor.py, for superside-chat.)
 *
 * `backgroundPin`/`backgroundNote` are the model of the background Types (goal, teacher). On
 * claude-sdk they are pinned to Haiku. On pi nothing is pinned: a Claude id would not run
 * there, so they follow the engine's `fast` mapping for the harness
 * (OMNIGENT_HELPER_MODEL_FAST_PI, else the parent's model). */
const MUSE_BUNDLES = [
  {
    name: "nova-claude",
    harness: "claude-sdk",
    harnessName: "Claude Agent SDK",
    executorExtra: "",
    skillsFilter: "",
    backgroundNote:
      "# Background work: pinned to Haiku (Nova's Muse keeps NOVA_CLAUDE_MODEL). Parity plan Q9.",
    backgroundPin: "  model: claude-haiku-4-5",
  },
  {
    name: "nova-pi",
    harness: "pi",
    harnessName: "Pi",
    executorExtra: "    context_files: false\n    system_prompt_mode: replace",
    skillsFilter: "skills: none",
    backgroundNote:
      "# Background work: no model pinned; it follows the engine's `fast` mapping for pi, else the\n" +
      "# parent's model (OMNIGENT_HELPER_MODEL_FAST_PI).",
    backgroundPin: "",
  },
];
/** Env var naming documented in docs/omnigent-spike.md / docs/super-chat/README.md. */
const MODEL_ENV = "NOVA_CLAUDE_MODEL";
/** One directory per Sub-agent Type (CONTEXT.md), each a config.yaml template rendered with the
 * bundle's harness keys. */
const SUB_AGENT_TYPES = ["worker", "worker/agents/subworker", "goal", "teacher"];
const GENERATED_HEADER =
  "# GENERATED FILE — do not edit by hand. Edit the matching file under\n" +
  "# infra/omnigent/templates/, then run `node infra/omnigent/render-agents.mjs`.\n\n";

function render(template, values) {
  return Object.entries(values).reduce((text, [key, value]) => {
    // A line holding only an empty placeholder is dropped, so optional keys leave no blank line.
    const withoutEmptyLine = value === "" ? text.replaceAll(`{{${key}}}\n`, "") : text;
    return withoutEmptyLine.replaceAll(`{{${key}}}`, value);
  }, template);
}

/** Indents every line but the first, so a multi-line partial fits a YAML block scalar. */
function indent(text, spaces) {
  const pad = " ".repeat(spaces);
  return text
    .trimEnd()
    .split("\n")
    .map((line, i) => (i === 0 || line === "" ? line : pad + line))
    .join("\n");
}

function main() {
  const configTemplate = readFileSync(join(here, "templates/config.yaml.tmpl"), "utf8");
  const filesystem = readFileSync(join(here, "templates/filesystem.md"), "utf8").trimEnd();
  const agentsMd = render(readFileSync(join(here, "templates/AGENTS.md"), "utf8"), {
    FILESYSTEM: filesystem,
  });

  for (const bundle of MUSE_BUNDLES) {
    const outDir = join(AGENTS_DIR, bundle.name);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      join(outDir, "config.yaml"),
      render(configTemplate, {
        MODEL_ENV,
        BUNDLE_NAME: bundle.name,
        HARNESS: bundle.harness,
        EXECUTOR_EXTRA: bundle.executorExtra,
        SKILLS_FILTER: bundle.skillsFilter,
      }),
    );
    writeFileSync(join(outDir, "AGENTS.md"), agentsMd);
    console.log(`wrote ${outDir}/config.yaml and AGENTS.md`);

    for (const type of SUB_AGENT_TYPES) {
      const subTemplate = readFileSync(join(here, `templates/agents/${type}/config.yaml`), "utf8");
      const subDir = join(outDir, "agents", type);
      mkdirSync(subDir, { recursive: true });
      writeFileSync(
        join(subDir, "config.yaml"),
        GENERATED_HEADER +
          render(subTemplate, {
            FILESYSTEM: indent(filesystem, 2),
            HARNESS: bundle.harness,
            HARNESS_NAME: bundle.harnessName,
            EXECUTOR_EXTRA: bundle.executorExtra,
            SKILLS_FILTER: bundle.skillsFilter,
            BACKGROUND_NOTE: bundle.backgroundNote,
            BACKGROUND_PIN: bundle.backgroundPin,
          }),
      );
      console.log(`wrote ${subDir}/config.yaml`);
    }
  }
}

main();
