import { randomUUID } from "node:crypto";
import { computerControlExpireJobKey } from "@aiden/adapter-kit";
import type { ComputerExecutionLease } from "@aiden/adapters";
import {
  acquireComputerExecutionLease,
  ComputerBusyError,
  checkpointAndRecordComputerWorkspace,
  computerSupportsUpdate,
  computerUpdateView,
  provisionComputer,
  queueComputerUpdate,
  releaseComputerExecutionLease,
  scheduleComputerSleep,
  screenLeaseIdForRun,
  toComputerRef,
} from "@aiden/adapters";
import { ACTIVE_RUN_STATUSES } from "@aiden/core";
import { IsolationError } from "@aiden/db";
import { ORPCError } from "@orpc/server";
import { engineComputerClient, engineComputerStatus } from "../engine-computer.js";
import { computerControlProcedures } from "./computer-control.js";
import { computerStatus, runComputerReplace } from "./computer-support.js";
import type { RouterContext } from "./context.js";
import { computerContext } from "./shared.js";

export function computerRouter(c: RouterContext) {
  const { deps, authed, repos } = c;
  return {
    computer: {
      status: authed.computer.status.handler(async ({ context, input }) => {
        const engine = engineComputerClient();
        return engine
          ? engineComputerStatus(deps, engine, context.actor, input.botId)
          : computerStatus(deps, context.actor, input.botId);
      }),
      boot: authed.computer.boot.handler(async ({ context, input }) => {
        // The engine's Computer is always on: nothing to boot.
        const engine = engineComputerClient();
        if (engine) return engineComputerStatus(deps, engine, context.actor, input.botId);
        const bot = await repos.getBot(context.actor, input.botId);
        if (!bot.computer) throw new IsolationError();
        if (bot.computer.state === "running" && bot.computer.providerRef) {
          scheduleComputerSleep(deps.jobs, bot.computer.id);
          return computerStatus(deps, context.actor, input.botId);
        }
        const ctx = computerContext(context.actor, bot.id, "boot");
        const manualRunId = `boot:${randomUUID()}`;
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
          await provisionComputer(deps, bot.computer.id, {
            ...ctx,
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
        return computerStatus(deps, context.actor, input.botId);
      }),
      stop: authed.computer.stop.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        if (!bot.computer) throw new IsolationError();
        const controlLeaseId = bot.computer.controlLeaseId;
        const now = new Date();
        const claimed = await deps.prisma.computer.updateMany({
          where: {
            id: bot.computer.id,
            state: { not: "suspending" },
            maintenanceId: null,
            executionLeases: {
              none: { botId: { not: bot.id }, expiresAt: { gt: now } },
            },
          },
          data: { state: "suspending" },
        });
        if (claimed.count !== 1) {
          throw new ORPCError("CONFLICT", {
            message: "Other Team bots are still using this computer",
          });
        }
        const otherRun = await deps.prisma.run.findFirst({
          where: {
            botId: { not: bot.id },
            status: { in: [...ACTIVE_RUN_STATUSES] },
            bot: { computerId: bot.computer.id },
          },
          select: { id: true },
        });
        if (otherRun) {
          await deps.prisma.computer.updateMany({
            where: { id: bot.computer.id, state: "suspending" },
            data: { state: bot.computer.state },
          });
          throw new ORPCError("CONFLICT", {
            message: "Other Team bots are still using this computer",
          });
        }
        await deps.prisma.computerExecutionLease.deleteMany({
          where: { computerId: bot.computer.id, botId: bot.id },
        });
        try {
          if (bot.computer.providerRef) {
            const ctx = computerContext(context.actor, bot.id, "stop");
            const ref = toComputerRef(bot.computer);
            await checkpointAndRecordComputerWorkspace(deps, bot.computer, ref, ctx);
            await deps.sandbox.stop(ref, ctx);
          }
          await deps.prisma.computer.update({
            where: { id: bot.computer.id },
            data: {
              state: "stopped",
              controlHolder: "none",
              controlLeaseId: null,
              controlLeaseExpiresAt: null,
              controlBotId: null,
              controlRunId: null,
            },
          });
        } catch (error) {
          await deps.prisma.computer
            .updateMany({
              where: { id: bot.computer.id, state: "suspending" },
              data: { state: "error" },
            })
            .catch(() => undefined);
          throw error;
        }
        await deps.jobs.cancel(
          computerControlExpireJobKey(bot.computer.id, controlLeaseId ?? undefined),
        );
        return computerStatus(deps, context.actor, input.botId);
      }),
      recover: authed.computer.recover.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        if (!bot.computer) throw new IsolationError();
        try {
          return await queueComputerUpdate(deps, bot.computer.id, bot.id, "recover");
        } catch (error) {
          if (error instanceof ComputerBusyError)
            throw new ORPCError("CONFLICT", { message: "Computer is busy" });
          throw error;
        }
      }),
      reset: authed.computer.reset.handler(async ({ context, input }) =>
        runComputerReplace(deps, context, input.botId, "reset", "reset"),
      ),
      update: authed.computer.update.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        if (!bot.computer) throw new IsolationError();
        if (!computerSupportsUpdate(bot.computer.kind))
          throw new ORPCError("BAD_REQUEST", {
            message: "Computer update is not available on this device",
          });
        try {
          return await queueComputerUpdate(deps, bot.computer.id, bot.id);
        } catch (error) {
          if (error instanceof ComputerBusyError)
            throw new ORPCError("CONFLICT", { message: "Computer is busy" });
          throw error;
        }
      }),
      updates: authed.computer.updates.handler(async ({ context }) => {
        const rows = await deps.prisma.computerUpdate.findMany({
          where: {
            status: { in: ["queued", "running", "interrupted", "failed"] },
            computer: {
              spaceId: context.actor.spaceId,
              bots: { some: { userId: context.actor.userId, archivedAt: null } },
            },
          },
          include: {
            computer: {
              include: {
                bots: {
                  where: { userId: context.actor.userId, archivedAt: null },
                  select: { id: true, name: true },
                },
              },
            },
          },
          orderBy: { createdAt: "desc" },
        });
        return rows.map((row) => computerUpdateView(row, context.actor.isDeploymentOwner));
      }),
      releaseInterrupted: authed.computer.releaseInterrupted.handler(async ({ context, input }) => {
        if (!context.actor.isDeploymentOwner) throw new ORPCError("FORBIDDEN");
        // This is an attended lock release, never a heartbeat-based takeover.
        // The contract requires the operator's explicit workersStopped assertion.
        await deps.prisma.$transaction(async (tx) => {
          const update = await tx.computerUpdate.findFirst({
            where: {
              id: input.id,
              status: "interrupted",
              computer: {
                spaceId: context.actor.spaceId,
                bots: { some: { userId: context.actor.userId, archivedAt: null } },
              },
            },
          });
          if (!update) throw new ORPCError("CONFLICT");
          const failed = await tx.computerUpdate.updateMany({
            where: { id: update.id, status: "interrupted" },
            data: { status: "failed" },
          });
          if (failed.count !== 1) throw new ORPCError("CONFLICT");
          const released = await tx.computer.updateMany({
            where: { id: update.computerId, maintenanceId: update.id },
            data: { maintenanceId: null, state: "error" },
          });
          if (released.count !== 1) throw new ORPCError("CONFLICT");
        });
        return { ok: true as const };
      }),
      dismissUpdate: authed.computer.dismissUpdate.handler(async ({ context, input }) => {
        await deps.prisma.computerUpdate.updateMany({
          where: {
            id: input.id,
            status: "failed",
            computer: {
              spaceId: context.actor.spaceId,
              bots: { some: { userId: context.actor.userId, archivedAt: null } },
            },
          },
          data: { status: "dismissed" },
        });
        return { ok: true as const };
      }),
      ...computerControlProcedures(c),
    },
  };
}
