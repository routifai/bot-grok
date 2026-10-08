import type { AdapterContext } from "@nova/adapter-kit";
import type { Actor, Me } from "@nova/contracts";
import { findDefaultModelCredential } from "@nova/db";

import type { RouterDeps } from "./context.js";

export const THREAD_MESSAGE_PAGE_SIZE = 100;

export function computerContext(actor: Actor, botId: string, operationId: string): AdapterContext {
  return {
    operationId,
    traceId: operationId,
    spaceId: actor.spaceId,
    userId: actor.userId,
    botId,
    signal: new AbortController().signal,
  };
}

export function connectionContext(
  actor: Pick<Actor, "spaceId" | "userId">,
  operationId: string,
  signal?: AbortSignal,
): AdapterContext {
  return {
    operationId,
    traceId: operationId,
    spaceId: actor.spaceId,
    userId: actor.userId,
    signal: signal ?? new AbortController().signal,
  };
}

export async function meDto(deps: RouterDeps, actor: Actor): Promise<Me> {
  const [user, setup] = await Promise.all([
    deps.prisma.user.findUniqueOrThrow({ where: { id: actor.userId } }),
    modelSetup(deps, actor),
  ]);
  return {
    userId: actor.userId,
    email: user.email,
    name: user.name,
    spaceId: actor.spaceId,
    isDeploymentOwner: actor.isDeploymentOwner,
    needsModel: setup.needsModel,
    defaultProvider:
      setup.credential?.provider ??
      setup.settings?.defaultModelProvider ??
      deps.env.defaultProvider,
    defaultModel:
      setup.credential?.defaultModel ?? setup.settings?.defaultModelId ?? deps.env.defaultModel,
    computerHost: computerHostFor(setup.settings?.computerHost, deps.env.sandboxProvider),
    canChooseHostComputer: actor.isDeploymentOwner && deps.env.sandboxProvider === "docker",
    sandboxProvider: deps.env.sandboxProvider,
    avatarStyle: user.avatarStyle === "organic" ? "organic" : "robot",
    timezone: user.timezone,
  };
}

export async function modelSetup(deps: RouterDeps, actor: Actor) {
  const [credential, settings] = await Promise.all([
    findDefaultModelCredential(deps.prisma, actor),
    deps.prisma.deploymentSettings.findUnique({ where: { id: "default" } }),
  ]);
  const hasDeployment = Boolean(deps.env.deploymentModelKey);
  return {
    credential,
    settings,
    needsModel: deps.env.agentRuntime !== "scripted" && !credential && !hasDeployment,
  };
}

export function computerHostFor(
  stored: string | null | undefined,
  sandboxProvider: string,
): "docker" | "this-mac" | null {
  if (sandboxProvider === "desktop") return "this-mac";
  if (sandboxProvider !== "docker") return null;
  if (stored === "this-mac" || stored === "docker") return stored;
  return null;
}

export function mapRoutine(row: {
  id: string;
  botId: string;
  name: string;
  prompt: string;
  crons: string[];
  timezone: string;
  active: boolean;
  notify: boolean;
  webhookEnabled: boolean;
  githubEnabled: boolean;
  messageProvider: string | null;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: row.id,
    botId: row.botId,
    name: row.name,
    prompt: row.prompt,
    crons: row.crons,
    timezone: row.timezone,
    active: row.active,
    notify: row.notify,
    webhookEnabled: row.webhookEnabled,
    githubEnabled: row.githubEnabled,
    messageProvider: row.messageProvider,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    nextRunAt: row.nextRunAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listRoutinesDto(deps: RouterDeps, actor: Actor, botId: string) {
  const rows = await deps.prisma.routine.findMany({
    where: { botId, spaceId: actor.spaceId },
  });
  return rows.map(mapRoutine);
}
