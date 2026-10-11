import { computerSupportsUpdate } from "@superchat/adapters";
import type { ComputerStatus } from "@superchat/contracts";
import { ACTIVE_RUN_STATUSES } from "@superchat/core";
import type { PrismaClient } from "@superchat/db";

/** The name of the bot using this shared Computer right now, or `null` when none is. */
export async function resolveBusyBotName(
  prisma: PrismaClient,
  input: {
    computerId: string | null | undefined;
    botId: string;
    botName: string;
  },
): Promise<string | null> {
  if (!input.computerId) return null;
  const lease = await prisma.computerExecutionLease.findUnique({
    where: { computerId_botId: { computerId: input.computerId, botId: input.botId } },
    select: { expiresAt: true, runId: true },
  });
  if (!lease) return null;
  const run = await prisma.run.findUnique({
    where: { id: lease.runId },
    select: { status: true },
  });
  const leaseActive = lease.expiresAt.getTime() > Date.now();
  const runActive = Boolean(
    run?.status && (ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status),
  );
  return leaseActive || runActive ? input.botName : null;
}

export function toComputerStatus(
  botId: string,
  computer: {
    kind: string;
    state: string;
    scope: string;
    homeRevision: string;
    maintenanceId?: string | null;
  } | null,
  busyBotName: string | null = null,
): ComputerStatus {
  const state = computer?.maintenanceId
    ? "booting"
    : computer?.state === "suspending"
      ? "running"
      : computer?.state === "stopped" ||
          computer?.state === "booting" ||
          computer?.state === "running" ||
          computer?.state === "suspended" ||
          computer?.state === "error"
        ? computer.state
        : "stopped";
  const kind = (computer?.kind ?? "fake") as ComputerStatus["kind"];
  return {
    botId,
    mode: computer?.scope === "dedicated" ? "dedicated" : "team",
    kind,
    state,
    homeRevision: computer?.homeRevision ?? null,
    busyBotName,
    canUpdate: computerSupportsUpdate(kind),
  };
}
