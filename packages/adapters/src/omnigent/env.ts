// Shared env wiring for the NOVA_ENGINE=omnigent spike (docs/omnigent-spike.md), used by both
// apps/api and apps/worker so the flag and its supporting env vars behave identically in
// whichever process runs "run.continue" jobs.
import type { PrismaClient, ThreadEvents } from "@aiden/db";
import type { OmnigentGatewayDeps } from "./gateway.js";
import { DEFAULT_AGENT_NAME } from "./harnesses.js";

/**
 * `undefined` unless `NOVA_ENGINE=omnigent` is set, in which case it throws on a missing
 * `OMNIGENT_URL` / `OMNIGENT_PROXY_SECRET` — fail loud at boot rather than silently falling
 * back to the existing engine on every turn.
 */
export function omnigentGatewayDepsFromEnv(
  env: NodeJS.ProcessEnv,
  prisma: PrismaClient,
  events: ThreadEvents,
  secrets: string[],
): OmnigentGatewayDeps | undefined {
  if (env.NOVA_ENGINE !== "omnigent") return undefined;

  const baseUrl = env.OMNIGENT_URL?.trim();
  const proxySecret = env.OMNIGENT_PROXY_SECRET?.trim();
  if (!baseUrl) throw new Error("OMNIGENT_URL is required when NOVA_ENGINE=omnigent");
  if (!proxySecret) throw new Error("OMNIGENT_PROXY_SECRET is required when NOVA_ENGINE=omnigent");

  return {
    prisma,
    events,
    client: { baseUrl, proxySecret },
    secrets,
    agentName: env.OMNIGENT_AGENT_NAME?.trim() || DEFAULT_AGENT_NAME,
  };
}
