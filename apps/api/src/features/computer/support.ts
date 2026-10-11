import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import type { ComputerExecutionLease } from "@superchat/adapters";
import {
  acquireComputerExecutionLease,
  ComputerBusyError,
  computerSupportsUpdate,
  releaseComputerExecutionLease,
  replaceComputer,
  scheduleComputerSleep,
  screenLeaseIdForRun,
} from "@superchat/adapters";
import type { Actor, ComputerStatus } from "@superchat/contracts";
import { createRepos, IsolationError } from "@superchat/db";
import type { RouterDeps } from "../../routers/context.js";
import { computerContext } from "../../routers/shared.js";
import { resolveBusyBotName, toComputerStatus } from "./status.js";

export async function computerStatus(
  deps: RouterDeps,
  actor: Actor,
  botId: string,
): Promise<ComputerStatus> {
  const repos = createRepos(deps.prisma);
  const bot = await repos.getBot(actor, botId);
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
