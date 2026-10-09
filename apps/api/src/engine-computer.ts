// `computer.*` for Muses whose Computer the engine owns (docs/adr/0004-engine-owns-the-computer.md).
// Nova's API asks the engine which Computer, its screen and who controls it, and relays the screen
// stream through its same-origin proxy. It keeps no Computer state: no providerRef, no lease row.
import {
  getOmnigentComputer,
  type OmnigentClientConfig,
  omnigentClientConfigFromEnv,
  omnigentClientFor,
  openOmnigentComputerScreen,
  releaseOmnigentComputer,
} from "@nova/adapters";
import type { Actor, ComputerStatus } from "@nova/contracts";
import { ENGINE_COMPUTER_ID, SCREEN_PROXY_TTL_MS } from "@nova/core/node/screen-capability";
import type { PrismaClient } from "@nova/db";
import { ORPCError } from "@orpc/server";
import { toComputerStatus } from "./computer-status.js";
import { addScreenProxyCapability } from "./screen-proxy.js";

export interface EngineComputerDeps {
  prisma: PrismaClient;
  env: { screenProxySecret: string; webOrigin: string };
}

interface EngineComputer {
  client: OmnigentClientConfig;
  email: string;
  sessionId: string | null;
  bot: { id: string; screenGeneration: number };
}

/** The engine client for this actor's space (the tenant every engine call carries), when Nova
 * runs on the engine; `undefined` keeps the Pi-era path. */
export function engineComputerClient(
  actor: Pick<Actor, "spaceId">,
  env: NodeJS.ProcessEnv = process.env,
): OmnigentClientConfig | undefined {
  const connection = omnigentClientConfigFromEnv(env);
  return connection ? omnigentClientFor(connection, actor.spaceId) : undefined;
}

async function resolve(
  deps: Pick<EngineComputerDeps, "prisma">,
  client: OmnigentClientConfig,
  actor: Actor,
  botId: string,
): Promise<EngineComputer> {
  const [bot, user, session] = await Promise.all([
    deps.prisma.bot.findFirst({
      where: { id: botId, spaceId: actor.spaceId, userId: actor.userId },
      select: { id: true, screenGeneration: true },
    }),
    deps.prisma.user.findUnique({ where: { id: actor.userId }, select: { email: true } }),
    deps.prisma.omnigentSession.findUnique({
      where: { botId },
      select: { omnigentSessionId: true },
    }),
  ]);
  if (!bot || !user) throw new ORPCError("NOT_FOUND", { message: "Muse not found" });
  return { client, email: user.email, sessionId: session?.omnigentSessionId ?? null, bot };
}

/** The engine session and owner email behind a Muse's Computer, for engine routes that act on
 * it (teaching records it). `sessionId` is `null` until the Muse has had a turn. */
export async function engineSessionOf(
  deps: Pick<EngineComputerDeps, "prisma">,
  client: OmnigentClientConfig,
  actor: Actor,
  botId: string,
): Promise<{ email: string; sessionId: string | null }> {
  const { email, sessionId } = await resolve(deps, client, actor, botId);
  return { email, sessionId };
}

async function state(target: EngineComputer) {
  if (!target.sessionId) return { available: false, in_control: false };
  return getOmnigentComputer(target.client, target.email, target.sessionId);
}

export async function engineComputerStatus(
  deps: EngineComputerDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  botId: string,
): Promise<ComputerStatus> {
  const { available, in_control, ready } = await state(await resolve(deps, client, actor, botId));
  const status = toComputerStatus(botId, {
    kind: "docker",
    state: available ? "running" : "stopped",
    scope: "dedicated",
    controlHolder: in_control ? "user" : "none",
    controlBotId: in_control ? botId : null,
    homeRevision: "",
  });
  return available && ready !== undefined ? { ...status, runnerReady: ready } : status;
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
  const target = await resolve(deps, client, actor, botId);
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
  const target = await resolve(deps, client, actor, botId);
  if (!target.sessionId || !(await state(target)).available) {
    throw new ORPCError("BAD_REQUEST", { message: "Nova's computer starts when Nova needs it" });
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
  const target = await resolve(deps, client, actor, botId);
  if (target.sessionId) await releaseOmnigentComputer(client, target.email, target.sessionId);
  return { ok: true };
}

/** A thread snapshot's `computer`, as the engine sees it, when Nova runs on the engine. */
export async function withEngineComputer<
  T extends { botId?: string; computer?: ComputerStatus | null },
>(deps: EngineComputerDeps, actor: Actor, snapshot: T): Promise<T> {
  const client = engineComputerClient(actor);
  if (!client || !snapshot.botId || !snapshot.computer) return snapshot;
  const computer = await engineComputerStatus(deps, client, actor, snapshot.botId);
  return { ...snapshot, computer };
}
