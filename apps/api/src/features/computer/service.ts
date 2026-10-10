// `computer.*` for Muses whose Computer the engine owns (docs/adr/0004-engine-owns-the-computer.md).
// Superchat's API asks the engine which Computer, its screen and who controls it, and relays the screen
// stream through its same-origin proxy. It keeps no Computer state: no providerRef, no lease row.

import { ORPCError } from "@orpc/server";
import {
  getOmnigentComputer,
  getOmnigentSession,
  type OmnigentClientConfig,
  openOmnigentComputerScreen,
  releaseOmnigentComputer,
} from "@superchat/adapters";
import type { Actor, ComputerStatus } from "@superchat/contracts";
import { ENGINE_COMPUTER_ID, SCREEN_PROXY_TTL_MS } from "@superchat/core/node/screen-capability";
import type { PrismaClient } from "@superchat/db";
import {
  type EngineComputer,
  engineComputerClient,
  resolveEngineComputer,
} from "../../engine-client.js";
import { addScreenProxyCapability } from "./screen-proxy.js";
import { toComputerStatus } from "./status.js";

export interface EngineComputerDeps {
  prisma: PrismaClient;
  env: { screenProxySecret: string; webOrigin: string };
}

async function state(target: EngineComputer) {
  if (!target.sessionId) return { available: false, in_control: false };
  return getOmnigentComputer(target.client, target.email, target.sessionId);
}

const LAUNCH_STAGES = new Set(["provisioning", "cloning", "starting", "connecting", "failed"]);

export async function engineComputerStatus(
  deps: EngineComputerDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  botId: string,
): Promise<ComputerStatus> {
  const { available, in_control, ready, launch } = await state(
    await resolveEngineComputer(deps, client, actor, botId),
  );
  // Running means the Conversation's runner is bound and connected (`ready`), with or without a
  // screen (`available`): a connected host or a Computer without a desktop is not "Sleeping".
  const running = available || ready === true;
  const status = toComputerStatus(botId, {
    kind: "docker",
    state: running ? "running" : "stopped",
    scope: "dedicated",
    controlHolder: in_control ? "user" : "none",
    controlBotId: in_control ? botId : null,
    homeRevision: "",
  });
  const screened = { ...status, screenAvailable: available && status.screenAvailable };
  const withReady = running && ready !== undefined ? { ...screened, runnerReady: ready } : screened;
  const stage = launch?.stage;
  return stage && stage !== "ready" && LAUNCH_STAGES.has(stage)
    ? { ...withReady, launch: { stage: stage as NonNullable<ComputerStatus["launch"]>["stage"] } }
    : withReady;
}

function relayed(deps: EngineComputerDeps, target: EngineComputer, url: string, held: boolean) {
  const screen = new URL(url);
  screen.searchParams.set("view_only", held ? "false" : "true");
  return addScreenProxyCapability(
    screen.toString(),
    deps.env.screenProxySecret,
    deps.env.webOrigin,
    {
      botId: target.bot.id,
      computerId: ENGINE_COMPUTER_ID,
      botGeneration: target.bot.screenGeneration,
      computerGeneration: 0,
      controlLeaseId: null,
    },
  );
}

export async function engineComputerScreenUrl(
  deps: EngineComputerDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  botId: string,
): Promise<{ url: string | null }> {
  const target = await resolveEngineComputer(deps, client, actor, botId);
  const current = await state(target);
  if (!target.sessionId || !current.available) return { url: null };
  const screen = await openOmnigentComputerScreen(
    client,
    target.email,
    target.sessionId,
    current.in_control,
  );
  return { url: relayed(deps, target, screen.screen_url, screen.in_control) };
}

export async function engineComputerTakeover(
  deps: Pick<EngineComputerDeps, "prisma">,
  client: OmnigentClientConfig,
  actor: Actor,
  botId: string,
): Promise<{ leaseId: string; expiresAt: string }> {
  const target = await resolveEngineComputer(deps, client, actor, botId);
  if (!target.sessionId || !(await state(target)).available) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Superchat's computer starts when Superchat needs it",
    });
  }
  await openOmnigentComputerScreen(client, target.email, target.sessionId, true);
  return {
    leaseId: ENGINE_COMPUTER_ID,
    expiresAt: new Date(Date.now() + SCREEN_PROXY_TTL_MS).toISOString(),
  };
}

export async function engineComputerRelease(
  deps: Pick<EngineComputerDeps, "prisma">,
  client: OmnigentClientConfig,
  actor: Actor,
  botId: string,
): Promise<{ ok: true }> {
  const target = await resolveEngineComputer(deps, client, actor, botId);
  if (target.sessionId) await releaseOmnigentComputer(client, target.email, target.sessionId);
  return { ok: true };
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
