// Shared env wiring for the NOVA_ENGINE=omnigent spike (docs/omnigent-spike.md), used by both
// apps/api and apps/worker so the flag and its supporting env vars behave identically in
// whichever process runs "run.continue" jobs.
import type { PrismaClient, ThreadEvents } from "@aiden/db";
import { resolveDeploymentModel } from "../deployment-model.js";
import type { OmnigentClientConfig } from "./client.js";
import type { OmnigentGatewayDeps } from "./gateway.js";
import { DEFAULT_AGENT_NAME } from "./harnesses.js";

/**
 * Settings documented in docs/super-chat/README.md's Settings table. Every value is resolved
 * once per call (from a passed-in or `process.env`) rather than cached, so tests can pass a
 * plain object instead of mutating env.
 */
export interface OmnigentSuperChatConfig {
  /** Upper bound on how long one Super Chat turn may run before the gateway gives up and fails
   * it (env `OMNIGENT_TURN_TIMEOUT_MS`). */
  turnTimeoutMs: number;
  /** How long a claimed run's lease is held before another worker invocation may reclaim it
   * (env `OMNIGENT_LEASE_DURATION_MS`). */
  leaseDurationMs: number;
  /** Only Super Chats with Omnigent-side activity this recently are scanned by the mirror job
   * (env `OMNIGENT_MIRROR_LOOKBACK_MS`; ./mirror.ts). */
  mirrorLookbackMs: number;
  /** Items fetched per Super Chat per mirror tick (env `OMNIGENT_MIRROR_PAGE_SIZE`). */
  mirrorPageSize: number;
  /** Messages fetched per `chats.messages` page (env `OMNIGENT_CHATS_PAGE_SIZE`;
   * apps/api/src/chats.ts). */
  chatsPageSize: number;
}

export const DEFAULT_OMNIGENT_SUPERCHAT_CONFIG: OmnigentSuperChatConfig = {
  turnTimeoutMs: 5 * 60_000,
  leaseDurationMs: 5 * 60_000,
  // A week, not a day: a Super Chat that only gets a Helper Result mirrored back once every
  // few days (not every turn) must not fall out of the mirror job's scan window in between.
  mirrorLookbackMs: 7 * 24 * 60 * 60 * 1000,
  mirrorPageSize: 50,
  chatsPageSize: 50,
};

function positiveIntFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

export function omnigentSuperChatConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): OmnigentSuperChatConfig {
  const defaults = DEFAULT_OMNIGENT_SUPERCHAT_CONFIG;
  return {
    turnTimeoutMs: positiveIntFromEnv(env.OMNIGENT_TURN_TIMEOUT_MS, defaults.turnTimeoutMs),
    leaseDurationMs: positiveIntFromEnv(env.OMNIGENT_LEASE_DURATION_MS, defaults.leaseDurationMs),
    mirrorLookbackMs: positiveIntFromEnv(
      env.OMNIGENT_MIRROR_LOOKBACK_MS,
      defaults.mirrorLookbackMs,
    ),
    mirrorPageSize: positiveIntFromEnv(env.OMNIGENT_MIRROR_PAGE_SIZE, defaults.mirrorPageSize),
    chatsPageSize: positiveIntFromEnv(env.OMNIGENT_CHATS_PAGE_SIZE, defaults.chatsPageSize),
  };
}

/**
 * The secrets redacted out of anything Omnigent sends back before it reaches a log, a thrown
 * `Error`, or an RPC response. Same composition `apps/api/src/app.ts` / `apps/worker/src/
 * index.ts` already assemble as `runtimeSecrets` for ./gateway.ts and ./mirror.ts — both
 * composition roots now call this instead of inlining it twice, and the `chats.*`/
 * `activities.*`/`memory.profile` read paths (apps/api/src/{chats,activities}.ts) call it too,
 * so every Omnigent-facing surface redacts with the identical list.
 */
export function omnigentRedactionSecretsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const { key } = resolveDeploymentModel(env);
  return [
    key ?? "",
    env.COMPOSIO_API_KEY ?? "",
    env.CURSOR_API_KEY ?? "",
    env.TYPESAFE_API_KEY ?? "",
  ].filter(Boolean);
}

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
    client: { baseUrl, proxySecret, secrets },
    secrets,
    agentName: env.OMNIGENT_AGENT_NAME?.trim() || DEFAULT_AGENT_NAME,
    config: omnigentSuperChatConfigFromEnv(env),
  };
}

/**
 * The Omnigent client config for query-side Super Chat calls (`chats.*`/`activities.*`,
 * apps/api/src/chats.ts and ./activities.ts) — `undefined` whenever Nova isn't running on the
 * Omnigent engine or is missing `OMNIGENT_URL`/`OMNIGENT_PROXY_SECRET`, so callers can surface a
 * clean "not available" response instead of throwing at request time. Boot-time wiring
 * (`omnigentGatewayDepsFromEnv`, run path) stays strict/throwing; this is read lazily per
 * request so a deployment that hasn't opted in gets a normal `BAD_REQUEST`, not a crash.
 */
export function omnigentClientConfigFromEnv(
  env: NodeJS.ProcessEnv,
): OmnigentClientConfig | undefined {
  if (env.NOVA_ENGINE !== "omnigent") return undefined;
  const baseUrl = env.OMNIGENT_URL?.trim();
  const proxySecret = env.OMNIGENT_PROXY_SECRET?.trim();
  if (!baseUrl || !proxySecret) return undefined;
  return { baseUrl, proxySecret, secrets: omnigentRedactionSecretsFromEnv(env) };
}
