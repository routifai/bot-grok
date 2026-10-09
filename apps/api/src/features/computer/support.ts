import { randomUUID } from "node:crypto";
import type { AdapterContext } from "@nova/adapter-kit";
import type { ComputerExecutionLease } from "@nova/adapters";
import {
  acquireComputerExecutionLease,
  ComputerBusyError,
  clearInactiveUserComputerControl,
  computerSupportsUpdate,
  expireComputerControl,
  hasActiveComputerControl,
  releaseComputerExecutionLease,
  replaceComputer,
  scheduleComputerSleep,
  screenLeaseIdForRun,
} from "@nova/adapters";
import type { Actor, ComputerStatus } from "@nova/contracts";
import type { PrismaClient } from "@nova/db";
import { createRepos, IsolationError } from "@nova/db";
import { ORPCError } from "@orpc/server";
import type { RouterDeps } from "../../routers/context.js";
import { computerContext } from "../../routers/shared.js";
import { resolveBusyBotName, toComputerStatus } from "./status.js";

export async function computerStatus(
  deps: RouterDeps,
  actor: Actor,
  botId: string,
): Promise<ComputerStatus> {
  const repos = createRepos(deps.prisma);
  let bot = await repos.getBot(actor, botId);
  if (await expireStaleComputerControl(deps, bot.computer)) {
    bot = await repos.getBot(actor, botId);
  }
  const busyBotName = await resolveBusyBotName(deps.prisma, {
    computerId: bot.computer?.id,
    botId,
    botName: bot.name,
  });
  return toComputerStatus(botId, bot.computer, busyBotName);
}

export async function runComputerReplace(
  deps: RouterDeps,
  context: { actor: Actor },
  botId: string,
  mode: "recover" | "reset" | "update",
  operationId: string,
): Promise<ComputerStatus> {
  const repos = createRepos(deps.prisma);
  const bot = await repos.getBot(context.actor, botId);
  if (!bot.computer) throw new IsolationError();
  if (mode === "update" && !computerSupportsUpdate(bot.computer.kind)) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Computer update is not available on this device",
    });
  }
  const manualRunId = `${mode}:${randomUUID()}`;
  let lease: ComputerExecutionLease | null;
  try {
    lease = await acquireComputerExecutionLease(deps.prisma, {
      computerId: bot.computer.id,
      runId: manualRunId,
      botId: bot.id,
    });
  } catch (error) {
    if (error instanceof ComputerBusyError) {
      throw new ORPCError("CONFLICT", { message: "Computer is busy" });
    }
    throw error;
  }
  try {
    await replaceComputer(deps, bot.computer.id, mode, {
      ...computerContext(context.actor, bot.id, operationId),
      screenLeaseId: screenLeaseIdForRun(lease, manualRunId),
    });
    scheduleComputerSleep(deps.jobs, bot.computer.id);
  } catch (error) {
    if (error instanceof ComputerBusyError) {
      throw new ORPCError("CONFLICT", { message: "Computer is busy" });
    }
    throw error;
  } finally {
    await releaseComputerExecutionLease(deps.prisma, lease);
  }
  return computerStatus(deps, context.actor, botId);
}

export async function expireStaleComputerControl(
  deps: RouterDeps,
  computer:
    | (NonNullable<Parameters<typeof hasActiveComputerControl>[0]> & {
        id: string;
        controlHolder?: string;
      })
    | null
    | undefined,
): Promise<boolean> {
  if (!computer || hasActiveComputerControl(computer)) return false;
  if (computer.controlHolder !== "user") return false;
  const leaseId = computer.controlLeaseId;
  // Keep a failed revoke's lease id so reconciliation can retry provider shutdown.
  if (leaseId) {
    await expireComputerControl(deps, computer.id, leaseId).catch(() => undefined);
    return true;
  }
  return clearInactiveUserComputerControl(deps.prisma, computer.id).catch(() => false);
}

/** When the user already holds control during waiting_takeover, bind controlRunId so
 * takeoverRequested becomes true and release can resume the waiting run. */
export async function bindWaitingTakeoverToControl(
  deps: RouterDeps,
  input: {
    spaceId: string;
    threadId: string | null | undefined;
    botId: string;
    computerId: string;
    controlLeaseId: string;
    controlRunId: string | null;
  },
): Promise<void> {
  await deps.prisma.$transaction(async (tx) => {
    // Lock the execution lease so a reclaimed fence/run cannot be bound by a stale read.
    const locked = await tx.$queryRaw<Array<{ runId: string; fence: number }>>`
      SELECT "runId", fence FROM computer_execution_leases
      WHERE "computerId" = ${input.computerId} AND "botId" = ${input.botId}
      FOR UPDATE`;
    const executionLease = locked[0];
    if (!executionLease) return;

    const executionRun = await tx.run.findUnique({
      where: { id: executionLease.runId },
      select: { botId: true, status: true },
    });
    const waitingForTakeover =
      executionRun?.botId === input.botId && executionRun.status === "waiting_takeover";
    if (!waitingForTakeover) return;
    if (input.controlRunId === executionLease.runId) return;

    // Confirm the locked lease row still matches before writing controlRunId.
    const leaseStillCurrent = await tx.computerExecutionLease.count({
      where: {
        computerId: input.computerId,
        botId: input.botId,
        runId: executionLease.runId,
        fence: executionLease.fence,
      },
    });
    if (leaseStillCurrent !== 1) return;

    const bound = await tx.computer.updateMany({
      where: {
        id: input.computerId,
        controlLeaseId: input.controlLeaseId,
        controlBotId: input.botId,
      },
      data: { controlRunId: executionLease.runId },
    });
    if (bound.count !== 1 || !input.threadId) return;

    await deps.events.append({
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      type: "computer.takeover.granted",
      payload: { leaseId: input.controlLeaseId, takeoverRequested: true },
    });
  });
}

export async function computerScreenContext(
  prisma: PrismaClient,
  actor: Actor,
  computerId: string,
  botId: string,
  operationId: string,
): Promise<AdapterContext> {
  const context = computerContext(actor, botId, operationId);
  const lease = await prisma.computerExecutionLease.findUnique({
    where: { computerId_botId: { computerId, botId } },
    select: { runId: true, fence: true, expiresAt: true },
  });
  if (!lease || lease.expiresAt.getTime() <= Date.now()) return context;
  return { ...context, screenLeaseId: screenLeaseIdForRun(lease, lease.runId) };
}

export function withViewOnly(url: string, viewOnly: boolean) {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("view_only", viewOnly ? "true" : "false");
    return parsed.toString();
  } catch {
    const join = url.includes("?") ? "&" : "?";
    return `${url}${join}view_only=${viewOnly ? "true" : "false"}`;
  }
}
