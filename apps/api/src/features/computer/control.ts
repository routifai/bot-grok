import { randomUUID } from "node:crypto";
import type { SandboxProvider } from "@nova/adapter-kit";
import { computerControlExpireJobKey } from "@nova/adapter-kit";
import {
  clearInactiveUserComputerControl,
  displayBotWorkspacePath,
  enqueueTakeoverContinuation,
  expireComputerControl,
  hasActiveComputerControl,
  isComputerScreenUnavailable,
  isSandboxGoneError,
  resolveBotWorkspacePath,
  scheduleComputerControlExpiry,
  scheduleComputerSleep,
  takeoverLeaseMs,
  toComputerRef,
  touchRunningComputer,
} from "@nova/adapters";
import { IsolationError, parseComputerMode } from "@nova/db";
import { getLogger } from "@nova/logging";
import { ORPCError } from "@orpc/server";
import { engineComputerClient } from "../../engine-client.js";
import type { RouterContext } from "../../routers/context.js";
import { computerContext } from "../../routers/shared.js";
import { addScreenProxyCapability } from "./screen-proxy.js";
import {
  engineComputerRelease,
  engineComputerScreenUrl,
  engineComputerTakeover,
} from "./service.js";
import { executionBlocksUserTakeover } from "./status.js";
import {
  bindWaitingTakeoverToControl,
  computerScreenContext,
  expireStaleComputerControl,
  withViewOnly,
} from "./support.js";

const MAX_COMPUTER_TEXT_FILE_BYTES = 2 * 1024 * 1024;

export function computerControlProcedures(c: RouterContext) {
  const { deps, authed, repos } = c;
  return {
    takeover: authed.computer.takeover.handler(async ({ context, input }) => {
      const engine = engineComputerClient(context.actor);
      if (engine) return engineComputerTakeover(deps, engine, context.actor, input.botId);
      let bot = await repos.getBot(context.actor, input.botId);
      if (!bot.computer?.providerRef || bot.computer.state !== "running") {
        throw new ORPCError("BAD_REQUEST", { message: "computer must be running" });
      }
      if (hasActiveComputerControl(bot.computer) && bot.computer.controlBotId === bot.id) {
        await bindWaitingTakeoverToControl(deps, {
          spaceId: context.actor.spaceId,
          threadId: bot.thread?.id,
          botId: bot.id,
          computerId: bot.computer.id,
          controlLeaseId: bot.computer.controlLeaseId!,
          controlRunId: bot.computer.controlRunId,
        });
        await scheduleComputerControlExpiry(
          deps.jobs,
          bot.computer.id,
          bot.computer.controlLeaseId!,
          bot.computer.controlLeaseExpiresAt!,
        );
        return {
          leaseId: bot.computer.controlLeaseId!,
          expiresAt: bot.computer.controlLeaseExpiresAt!.toISOString(),
        };
      }
      if (hasActiveComputerControl(bot.computer) && bot.computer.controlBotId !== bot.id) {
        const previousBotId = bot.computer.controlBotId!;
        await deps.sandbox.setScreenControl?.(
          toComputerRef(bot.computer),
          false,
          computerContext(context.actor, previousBotId, "screen.release"),
          bot.computer.controlLeaseId ?? undefined,
        );
        await deps.prisma.computer.updateMany({
          where: { id: bot.computer.id, controlLeaseId: bot.computer.controlLeaseId },
          data: {
            controlHolder: "none",
            controlLeaseId: null,
            controlLeaseExpiresAt: null,
            controlBotId: null,
            controlRunId: null,
          },
        });
        bot = await repos.getBot(context.actor, input.botId);
        if (!bot.computer) throw new IsolationError();
      }
      if (bot.computer.controlLeaseId) {
        await expireComputerControl(deps, bot.computer.id, bot.computer.controlLeaseId);
        bot = await repos.getBot(context.actor, input.botId);
      }
      if (!bot.computer) throw new IsolationError();

      const executionLease = await deps.prisma.computerExecutionLease.findUnique({
        where: { computerId_botId: { computerId: bot.computer.id, botId: bot.id } },
      });
      const executionRun = executionLease
        ? await deps.prisma.run.findUnique({
            where: { id: executionLease.runId },
            select: { botId: true, status: true },
          })
        : null;
      const waitingForTakeover =
        executionRun?.botId === bot.id &&
        (executionRun.status === "waiting_takeover" ||
          bot.computer.controlRunId === executionLease?.runId);
      if (
        executionBlocksUserTakeover({
          hasLease: Boolean(executionLease),
          leaseExpiresAt: executionLease?.expiresAt,
          runStatus: executionRun?.status,
          takeoverRequested: waitingForTakeover,
        })
      ) {
        throw new ORPCError("CONFLICT", { message: "Stop the bot first" });
      }
      // Keep an inactive lease as a fencing tombstone. The next run reclaims it
      // with a higher fence, even if this user's screen remains connected.

      const leaseId = randomUUID();
      const expiresAt = new Date(Date.now() + takeoverLeaseMs());
      const granted = await deps.prisma.computer.updateMany({
        where: {
          id: bot.computer.id,
          state: "running",
          maintenanceId: null,
          controlHolder: { not: "user" },
          controlLeaseId: null,
        },
        data: {
          controlHolder: "user",
          controlLeaseId: leaseId,
          controlLeaseExpiresAt: expiresAt,
          controlBotId: bot.id,
          controlRunId: waitingForTakeover ? executionLease?.runId : null,
          state: "running",
        },
      });
      if (granted.count !== 1) {
        const current = await deps.prisma.computer.findUniqueOrThrow({
          where: { id: bot.computer.id },
        });
        if (!hasActiveComputerControl(current) || current.controlBotId !== bot.id) {
          throw new ORPCError("CONFLICT", { message: "Computer control changed; try again" });
        }
        await bindWaitingTakeoverToControl(deps, {
          spaceId: context.actor.spaceId,
          threadId: bot.thread?.id,
          botId: bot.id,
          computerId: current.id,
          controlLeaseId: current.controlLeaseId!,
          controlRunId: current.controlRunId,
        });
        await scheduleComputerControlExpiry(
          deps.jobs,
          current.id,
          current.controlLeaseId!,
          current.controlLeaseExpiresAt!,
        );
        return {
          leaseId: current.controlLeaseId!,
          expiresAt: current.controlLeaseExpiresAt!.toISOString(),
        };
      }
      try {
        await scheduleComputerControlExpiry(deps.jobs, bot.computer.id, leaseId, expiresAt);
      } catch (error) {
        await deps.prisma.computer.updateMany({
          where: { id: bot.computer.id, controlLeaseId: leaseId },
          data: {
            controlHolder: "none",
            controlLeaseId: null,
            controlLeaseExpiresAt: null,
            controlBotId: null,
            controlRunId: null,
          },
        });
        throw error;
      }
      if (bot.thread) {
        await deps.events.append({
          spaceId: context.actor.spaceId,
          threadId: bot.thread.id,
          botId: bot.id,
          type: "computer.takeover.granted",
          payload: { leaseId, takeoverRequested: waitingForTakeover },
        });
      }
      scheduleComputerSleep(deps.jobs, bot.computer.id);
      return { leaseId, expiresAt: expiresAt.toISOString() };
    }),
    release: authed.computer.release.handler(async ({ context, input }) => {
      const engine = engineComputerClient(context.actor);
      if (engine) return engineComputerRelease(deps, engine, context.actor, input.botId);
      const bot = await repos.getBot(context.actor, input.botId);
      if (!bot.computer) throw new IsolationError();
      const controlBotId = bot.computer.controlBotId;
      const controlLeaseId = bot.computer.controlLeaseId;
      if (bot.computer.controlHolder !== "user" || !controlBotId || controlBotId !== bot.id) {
        return { ok: true as const };
      }
      if (!hasActiveComputerControl(bot.computer) || !controlLeaseId) {
        // Stale controlHolder=user. Prefer expiry (revokes provider control). If a lease id
        // remains after a failed revoke, keep it so reconciliation can retry.
        if (controlLeaseId) {
          await expireComputerControl(deps, bot.computer.id, controlLeaseId).catch(() => undefined);
        } else {
          await clearInactiveUserComputerControl(deps.prisma, bot.computer.id);
        }
        return { ok: true as const };
      }
      if (bot.computer.providerRef) {
        await deps.sandbox.setScreenControl?.(
          toComputerRef(bot.computer),
          false,
          computerContext(context.actor, controlBotId, "screen.release"),
          controlLeaseId,
        );
      }

      const released = await deps.events.finalizeComputerControlRelease({
        spaceId: context.actor.spaceId,
        computerId: bot.computer.id,
        botId: controlBotId,
        runId: bot.computer.controlRunId,
        leaseId: controlLeaseId,
        holder: "bot",
        reason: input.reason ?? "released",
      });
      if (!released) return { ok: true as const };
      // The lease-specific key makes this cancellation safe after a replacement takeover.
      await deps.jobs
        .cancel(computerControlExpireJobKey(bot.computer.id, controlLeaseId))
        .catch((error) => {
          // The expired job is harmless after the lease is cleared, so do not report a
          // failed release after the transaction has committed.
          getLogger().error("computer control expiry cancellation", error);
        });

      await enqueueTakeoverContinuation(deps.jobs, released.runId);
      scheduleComputerSleep(deps.jobs, bot.computer.id);
      return { ok: true as const };
    }),
    files: authed.computer.files.handler(async ({ context, input }) => {
      const bot = await repos.getBot(context.actor, input.botId);
      if (!bot.computer) throw new IsolationError();
      const computer = bot.computer;
      const computerMode = parseComputerMode(computer.scope);
      const ctx = computerContext(context.actor, bot.id, "files");
      const storedPath = resolveBotWorkspacePath(computerMode, bot.id, input.path);
      let entries: Awaited<ReturnType<SandboxProvider["listFiles"]>>;
      if (computer.state === "running" && computer.providerRef) {
        await deps.prisma.computer.updateMany({
          where: { id: computer.id, state: "running" },
          data: { updatedAt: new Date() },
        });
        scheduleComputerSleep(deps.jobs, computer.id);
        entries = await deps.sandbox.listFiles(toComputerRef(computer), storedPath, ctx);
      } else {
        entries = await deps.home.list(computer.homeKey, storedPath, ctx);
      }
      return entries.map((entry) => ({
        ...entry,
        path: displayBotWorkspacePath(computerMode, bot.id, input.path, entry.path),
      }));
    }),
    readFile: authed.computer.readFile.handler(async ({ context, input }) => {
      const bot = await repos.getBot(context.actor, input.botId);
      if (!bot.computer) throw new IsolationError();
      const computerMode = parseComputerMode(bot.computer.scope);
      const ctx = computerContext(context.actor, bot.id, "read");
      const storedPath = resolveBotWorkspacePath(computerMode, bot.id, input.path);
      let content: string;
      if (bot.computer.state === "running" && bot.computer.providerRef) {
        await deps.prisma.computer.updateMany({
          where: { id: bot.computer.id, state: "running" },
          data: { updatedAt: new Date() },
        });
        scheduleComputerSleep(deps.jobs, bot.computer.id);
        const bytes = await deps.sandbox.readFile(toComputerRef(bot.computer), storedPath, ctx, {
          maxBytes: MAX_COMPUTER_TEXT_FILE_BYTES,
        });
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } else {
        try {
          content = await deps.home.readFile(bot.computer.homeKey, storedPath, ctx, {
            maxBytes: MAX_COMPUTER_TEXT_FILE_BYTES,
          });
        } catch (error) {
          if (error instanceof Error && error.message.startsWith("agent home file exceeds ")) {
            throw new ORPCError("BAD_REQUEST", { message: "file is too large to preview" });
          }
          throw error;
        }
      }
      return { path: input.path, content };
    }),
    screenUrl: authed.computer.screenUrl.handler(async ({ context, input }) => {
      const engine = engineComputerClient(context.actor);
      if (engine) return engineComputerScreenUrl(deps, engine, context.actor, input.botId);
      let bot = await repos.getBot(context.actor, input.botId);
      if (await expireStaleComputerControl(deps, bot.computer)) {
        bot = await repos.getBot(context.actor, input.botId);
      }
      if (
        !bot.computer?.providerRef ||
        (bot.computer.state !== "running" && bot.computer.state !== "booting")
      ) {
        return { url: null };
      }
      const computer = bot.computer;
      const session = await deps.sandbox
        .connectScreen(
          toComputerRef(computer),
          {
            view: "stream",
            interactive: hasActiveComputerControl(computer) && computer.controlBotId === bot.id,
            controlToken:
              computer.controlBotId === bot.id ? (computer.controlLeaseId ?? undefined) : undefined,
          },
          await computerScreenContext(deps.prisma, context.actor, computer.id, bot.id, "screen"),
        )
        .catch(async (error: unknown) => {
          if (isComputerScreenUnavailable(error)) {
            throw new ORPCError("CONFLICT", { message: error.message });
          }
          if (!isSandboxGoneError(error)) throw error;
          // The provider killed this sandbox (idle timeout) while the row still says
          // running. Clear the dead ref so the UI offers a boot instead of 500ing.
          // Leave any active control lease alone — expireComputerControl owns that
          // release (provider screen-control, events, takeover continuation).
          getLogger().error(
            `computer ${computer.id} sandbox ${computer.providerRef} is gone`,
            error,
          );
          await deps.prisma.computer.updateMany({
            where: { id: computer.id, providerRef: computer.providerRef },
            data: { state: "stopped", providerRef: null },
          });
          return null;
        });
      if (!session?.url) return { url: null };
      scheduleComputerSleep(deps.jobs, bot.computer.id);
      const viewUrl = withViewOnly(
        session.url,
        !(hasActiveComputerControl(bot.computer) && bot.computer.controlBotId === bot.id),
      );
      return {
        url: addScreenProxyCapability(viewUrl, deps.env.screenProxySecret, deps.env.webOrigin, {
          botId: bot.id,
          computerId: computer.id,
          botGeneration: bot.screenGeneration,
          computerGeneration: computer.screenGeneration,
          controlLeaseId: computer.controlLeaseId,
        }),
      };
    }),
    heartbeat: authed.computer.heartbeat.handler(async ({ context, input }) => {
      const bot = await repos.getBot(context.actor, input.botId);
      if (bot.computer?.state === "running" && bot.computer.providerRef) {
        await deps.prisma.computer.updateMany({
          where: { id: bot.computer.id, state: "running" },
          data: { updatedAt: new Date() },
        });
        await touchRunningComputer(
          { sandbox: deps.sandbox, jobs: deps.jobs },
          {
            id: bot.computer.id,
            homeKey: bot.computer.homeKey,
            providerRef: bot.computer.providerRef,
            kind: bot.computer.kind,
          },
        ).catch(() => undefined);
      }
      return { ok: true as const };
    }),
  };
}
