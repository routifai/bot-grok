import * as z from "zod";

// Nova's run engine (docs/omnigent-spike.md): when NOVA_ENGINE=omnigent, a Muse's Conversation
// turns run on Omnigent (engine/omnigent/), and the person can choose which harness — an
// Omnigent-speak for "which coding/agent runtime and model family" — their Muse runs on, and
// switch mid-Conversation. `engine.info` / `engine.setHarness` in packages/contracts/src/rpc.ts.

/** One Omnigent built-in agent bundle (infra/omnigent/agents/nova-<id>/) a Muse can run on. */
export const NovaHarnessIdSchema = z.enum(["pi", "claude", "openai", "codex"]);
export type NovaHarnessId = z.infer<typeof NovaHarnessIdSchema>;

export const EngineHarnessSchema = z.object({
  id: NovaHarnessIdSchema,
  /** Built-in Omnigent agent bundle name, e.g. "nova-pi" (infra/omnigent/agents/). */
  agentName: z.string(),
  /** Display name, e.g. "Pi". */
  name: z.string(),
  /** Who makes it, e.g. "Anthropic". */
  maker: z.string(),
  /** One short line describing the harness. */
  description: z.string(),
  available: z.boolean(),
  /** Set when `available` is false, e.g. "Add ANTHROPIC_API_KEY to .env". */
  unavailableReason: z.string().nullable(),
});
export type EngineHarness = z.infer<typeof EngineHarnessSchema>;

export const EngineInfoSchema = z.object({
  /** Whether Nova is running on the Omnigent engine at all (env NOVA_ENGINE=omnigent). */
  enabled: z.boolean(),
  /** The bot's chosen harness; null when `enabled` is false. Defaults to "pi" when enabled. */
  active: NovaHarnessIdSchema.nullable(),
  harnesses: z.array(EngineHarnessSchema),
});
export type EngineInfo = z.infer<typeof EngineInfoSchema>;
