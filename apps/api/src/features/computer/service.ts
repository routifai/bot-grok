// `computer.*` for Muses whose Computer the engine owns (docs/adr/0004-engine-owns-the-computer.md).
// Superchat's API asks the engine whether the Computer is ready and how its launch is going.
// It keeps no Computer state: no providerRef, no lease row.

import {
  getOmnigentComputer,
  getOmnigentSession,
  type OmnigentClientConfig,
} from "@superchat/adapters";
import type { Actor, ComputerStatus } from "@superchat/contracts";
import type { PrismaClient } from "@superchat/db";
import { engineComputerClient, resolveEngineComputer } from "../../engine-client.js";
import { toComputerStatus } from "./status.js";

export interface EngineComputerDeps {
  prisma: PrismaClient;
}

const LAUNCH_STAGES = new Set(["provisioning", "cloning", "starting", "connecting", "failed"]);

export async function engineComputerStatus(
  deps: EngineComputerDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  botId: string,
): Promise<ComputerStatus> {
  const target = await resolveEngineComputer(deps, client, actor, botId);
  const { ready, launch } = target.sessionId
    ? await getOmnigentComputer(target.client, target.email, target.sessionId)
    : { ready: false, launch: null };
  // Running means the Conversation's runner is bound and connected: a connected host is not "Sleeping".
  const status = {
    ...toComputerStatus(botId, {
      kind: "docker",
      state: ready ? "running" : "stopped",
      scope: "dedicated",
      homeRevision: "",
    }),
    runnerReady: ready,
  };
  const stage = launch?.stage;
  return stage && stage !== "ready" && LAUNCH_STAGES.has(stage)
    ? { ...status, launch: { stage: stage as NonNullable<ComputerStatus["launch"]>["stage"] } }
    : status;
}

/** A thread snapshot's `computer`, as the engine sees it, when Superchat runs on the engine. */
export async function withEngineComputer<
  T extends { botId?: string; computer?: ComputerStatus | null },
>(deps: EngineComputerDeps, actor: Actor, snapshot: T): Promise<T> {
  const client = engineComputerClient(actor);
  if (!client || !snapshot.botId || !snapshot.computer) return snapshot;
  const computer = await engineComputerStatus(deps, client, actor, snapshot.botId);
  return { ...snapshot, computer };
}

/** The built-in agent bundles Superchat runs the Muse on, and the harness each runs. */
const BUNDLE_HARNESS: Record<string, string> = {
  "superchat-claude": "claude-sdk",
  "superchat-pi": "pi",
};

/** Where the Muse's Conversation runs: the engine session's host and its agent bundle. */
export async function engineComputerHost(
  deps: EngineComputerDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  botId: string,
): Promise<{ hostId: string | null; agentName: string | null; harness: string | null }> {
  const target = await resolveEngineComputer(deps, client, actor, botId);
  if (!target.sessionId) return { hostId: null, agentName: null, harness: null };
  const [snapshot, row] = await Promise.all([
    getOmnigentSession(client, target.email, target.sessionId).catch(() => null),
    deps.prisma.omnigentSession.findUnique({
      where: { botId },
      select: { agentName: true },
    }),
  ]);
  const agentName = row?.agentName ?? null;
  return {
    hostId: snapshot?.host_id ?? null,
    agentName,
    harness: (agentName && BUNDLE_HARNESS[agentName]) || null,
  };
}
