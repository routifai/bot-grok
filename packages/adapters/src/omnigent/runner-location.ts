// Per-Muse runner location (contract: packages/contracts/src/engine.ts, docs/omnigent-spike.md
// "Nova computer" runner launcher): where the Omnigent runner that executes a Muse's shell/file/
// browser tools actually runs. Mirrors packages/adapters/src/omnigent/harnesses.ts's
// museHarness/resolveMuseHarnessId shape, minus the env-driven availability gating a runner
// location doesn't need — "computer" and "local" are always both selectable, and the create-time
// binding in ./gateway.ts is what surfaces a clear error when "local" has no connected host.
import type { NovaRunnerLocationId } from "@aiden/contracts";
import { NovaRunnerLocationIdSchema } from "@aiden/contracts";

/** The runner location a Muse without its own `museRunnerLocation` choice gets. */
export const DEFAULT_RUNNER_LOCATION: NovaRunnerLocationId = "computer";

export function isNovaRunnerLocationId(value: string): value is NovaRunnerLocationId {
  return NovaRunnerLocationIdSchema.safeParse(value).success;
}

/** The runner location a bot is configured to run on: its own `museRunnerLocation` choice
 * (Bot.museRunnerLocation), or the deployment default ("computer") when unset (null) or
 * unrecognized (e.g. a value from a future release rolled back). */
export function resolveMuseRunnerLocation(museRunnerLocation: string | null): NovaRunnerLocationId {
  if (museRunnerLocation && isNovaRunnerLocationId(museRunnerLocation)) return museRunnerLocation;
  return DEFAULT_RUNNER_LOCATION;
}
