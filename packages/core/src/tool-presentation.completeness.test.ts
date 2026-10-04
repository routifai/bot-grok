import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALWAYS_ON_SUPERSIDE_CHAT_TOOLS, TOOL_PRESENTATION } from "./tool-presentation.js";

// Forces registering a tool's presentation the moment it's added to Nova's agent bundle
// (infra/omnigent/agents/nova-claude/, generated from infra/omnigent/templates/) — see
// docs/super-chat/README.md "How to register a tool". No YAML dependency in this workspace, so
// this reads the `tools: builtins: - name: <tool>` lists with a small indentation-aware scan
// rather than a real parser; good enough for this bundle's shape.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "../../..");
const NOVA_AGENT_BUNDLE_DIR = join(REPO_ROOT, "infra/omnigent/agents/nova-claude");

function findConfigYamlFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...findConfigYamlFiles(full));
    } else if (entry === "config.yaml") {
      found.push(full);
    }
  }
  return found;
}

/** Every `- name: <tool>` entry under a `builtins:` list, anywhere in `tools:`. */
function builtinToolNames(yamlText: string): string[] {
  const names: string[] = [];
  let inBuiltins = false;
  let builtinsIndent = 0;
  for (const line of yamlText.split("\n")) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const builtinsHeader = /^(\s*)builtins:\s*$/.exec(line);
    if (builtinsHeader) {
      inBuiltins = true;
      builtinsIndent = (builtinsHeader[1] ?? "").length;
      continue;
    }
    if (!inBuiltins) continue;
    const indent = (/^(\s*)/.exec(line)?.[1] ?? "").length;
    const nameEntry = /^\s*-\s*name:\s*(\S+)\s*$/.exec(line);
    const name = nameEntry?.[1];
    if (name) {
      names.push(name);
      continue;
    }
    if (indent <= builtinsIndent) {
      // Dedented past the builtins list (a sibling key, or back out of `tools:`).
      inBuiltins = false;
    }
  }
  return names;
}

describe("tool presentation registry completeness", () => {
  it("has a presentation entry for every builtin tool declared in Nova's agent bundle", () => {
    const configFiles = findConfigYamlFiles(NOVA_AGENT_BUNDLE_DIR);
    expect(configFiles.length).toBeGreaterThan(0);

    const declaredTools = new Set<string>();
    for (const file of configFiles) {
      for (const name of builtinToolNames(readFileSync(file, "utf-8"))) declaredTools.add(name);
    }
    expect(declaredTools.size).toBeGreaterThan(0);

    for (const name of declaredTools) {
      expect(
        TOOL_PRESENTATION[name],
        `no tool-presentation registry entry for '${name}'`,
      ).toBeDefined();
    }
  });

  it("has a presentation entry for every always-on superside-chat tool", () => {
    for (const name of ALWAYS_ON_SUPERSIDE_CHAT_TOOLS) {
      expect(
        TOOL_PRESENTATION[name],
        `no tool-presentation registry entry for '${name}'`,
      ).toBeDefined();
    }
  });
});
