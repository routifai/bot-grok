// Catalog of Nova harness choices (contract: packages/contracts/src/engine.ts) a Muse can run
// its Omnigent Conversation turns on, one entry per bundle rendered by
// infra/omnigent/render-agents.mjs. Single source of truth for: the harness id <-> built-in
// agent bundle name mapping and each harness's env-driven availability, shared by
// `engine.info`/`engine.setHarness` (apps/api) and the gateway's per-turn agent resolution
// (./gateway.ts).
import type { EngineHarness, NovaHarnessId } from "@aiden/contracts";
import { NovaHarnessIdSchema } from "@aiden/contracts";

interface HarnessDef {
  id: NovaHarnessId;
  agentName: string;
  name: string;
  maker: string;
  description: string;
}

const HARNESSES: readonly HarnessDef[] = [
  {
    id: "pi",
    agentName: "nova-pi",
    name: "Pi",
    maker: "Open source",
    description: "Any model through OpenRouter or your own server",
  },
  {
    id: "claude",
    agentName: "nova-claude",
    name: "Claude",
    maker: "Anthropic",
    description: "Anthropic's Claude, strong at writing and careful work",
  },
  {
    id: "openai",
    agentName: "nova-openai",
    name: "OpenAI",
    maker: "OpenAI",
    description: "OpenAI models through the Agents SDK",
  },
  {
    id: "codex",
    agentName: "nova-codex",
    name: "Codex",
    maker: "OpenAI",
    description: "OpenAI's coding agent, best for code",
  },
];

/** Built-in agent bundle Nova Conversation turns run on when no per-bot choice overrides it
 * (env `OMNIGENT_AGENT_NAME`, ./env.ts). Kept here so the fallback name and the catalog it maps
 * back into a harness id never drift apart. */
export const DEFAULT_AGENT_NAME = "nova-pi";

export function isNovaHarnessId(value: string): value is NovaHarnessId {
  return NovaHarnessIdSchema.safeParse(value).success;
}

function harnessDef(id: NovaHarnessId): HarnessDef {
  const def = HARNESSES.find((harness) => harness.id === id);
  if (!def) throw new Error(`unknown Nova harness id: ${id}`);
  return def;
}

export function agentNameForHarnessId(id: NovaHarnessId): string {
  return harnessDef(id).agentName;
}

/** The harness id a built-in agent bundle name resolves to. Falls back to "pi" for a name
 * outside the catalog (e.g. a stale `OMNIGENT_AGENT_NAME`) so callers always get a harness id
 * rather than needing to handle "unknown". */
export function harnessIdForAgentName(agentName: string): NovaHarnessId {
  return HARNESSES.find((harness) => harness.agentName === agentName)?.id ?? "pi";
}

/** The harness a Muse without its own `museHarness` choice runs on: today's deployment-wide
 * `OMNIGENT_AGENT_NAME` default, kept for backwards compatibility with single-harness
 * deployments (docs/omnigent-spike.md). */
export function defaultHarnessId(env: NodeJS.ProcessEnv): NovaHarnessId {
  return harnessIdForAgentName(env.OMNIGENT_AGENT_NAME?.trim() || DEFAULT_AGENT_NAME);
}

/** The harness a bot is configured to run on: its own `museHarness` choice (Bot.museHarness),
 * or the deployment default when unset (null). */
export function resolveMuseHarnessId(
  museHarness: string | null,
  env: NodeJS.ProcessEnv,
): NovaHarnessId {
  if (museHarness && isNovaHarnessId(museHarness)) return museHarness;
  return defaultHarnessId(env);
}

/** The built-in agent bundle name a turn should run on for a bot, given the gateway's own
 * already-resolved default (`OmnigentGatewayDeps.agentName`, computed once at boot from
 * `OMNIGENT_AGENT_NAME` — ./env.ts) so the gateway never needs to read env per turn. */
export function agentNameForMuseHarness(
  museHarness: string | null,
  defaultAgentName: string,
): string {
  if (museHarness && isNovaHarnessId(museHarness)) return agentNameForHarnessId(museHarness);
  return defaultAgentName;
}

function harnessAvailability(
  id: NovaHarnessId,
  env: NodeJS.ProcessEnv,
): { available: boolean; unavailableReason: string | null } {
  switch (id) {
    case "pi":
      return env.OPENROUTER_API_KEY?.trim() || env.AIDEN_LOCAL_MODELS_URL?.trim()
        ? { available: true, unavailableReason: null }
        : { available: false, unavailableReason: "Add OPENROUTER_API_KEY to .env" };
    case "claude":
      return env.ANTHROPIC_API_KEY?.trim()
        ? { available: true, unavailableReason: null }
        : { available: false, unavailableReason: "Add ANTHROPIC_API_KEY to .env" };
    case "openai":
    case "codex":
      return env.OPENAI_API_KEY?.trim()
        ? { available: true, unavailableReason: null }
        : { available: false, unavailableReason: "Add OPENAI_API_KEY to .env" };
  }
}

/** The full `engine.info` harness catalog, with availability resolved from the API process's
 * own env. See ./harnesses.test.ts for the availability matrix. */
export function listNovaHarnesses(env: NodeJS.ProcessEnv): EngineHarness[] {
  return HARNESSES.map((harness) => ({
    id: harness.id,
    agentName: harness.agentName,
    name: harness.name,
    maker: harness.maker,
    description: harness.description,
    ...harnessAvailability(harness.id, env),
  }));
}
