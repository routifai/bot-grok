import type { AdapterContext, SandboxProvider } from "@nova/adapter-kit";
import {
  deleteOrganizations,
  type PrismaClient,
  personalOrganizations,
  purgeStaleEmailQuota,
  QUARANTINE_TTL_MS,
  quarantinedOrganizationsToPurge,
} from "@nova/db";
import { getLogger } from "@nova/logging";
import { toComputerRef } from "./computer-support.js";

type Deps = { prisma: PrismaClient; sandbox: SandboxProvider };

const context = (operation: string, userId = ""): AdapterContext => ({
  operationId: operation,
  traceId: operation,
  spaceId: "",
  userId,
  signal: new AbortController().signal,
});

const RELEASED = {
  controlHolder: "none" as const,
  controlLeaseId: null,
  controlLeaseExpiresAt: null,
  controlBotId: null,
  controlRunId: null,
  executionRunId: null,
  executionBotId: null,
  executionLeaseExpiresAt: null,
};

/** Every Computer row (team, group and dedicated scope) in these spaces that has a container. */
const computersIn = (prisma: PrismaClient, spaceIds: string[]) =>
  prisma.computer.findMany({ where: { spaceId: { in: spaceIds }, providerRef: { not: null } } });

/**
 * Stop, without destroying, every Computer in these spaces. Used while a space is quarantined:
 * nothing keeps running for an account nobody has confirmed, and it can start again if restored.
 */
export async function stopSpaceComputers(
  deps: Deps,
  spaceIds: string[],
  operation: string,
): Promise<void> {
  for (const computer of await computersIn(deps.prisma, spaceIds)) {
    if (!["running", "booting"].includes(computer.state)) continue;
    await deps.sandbox.stop(toComputerRef(computer), context(operation, computer.userId));
    await deps.prisma.computer.update({
      where: { id: computer.id },
      data: { state: "stopped", ...RELEASED },
    });
  }
}

/**
 * Destroy every Computer in these spaces and clear its provider reference, so the container and
 * its volume are gone before the rows that point at them are deleted. Throws if any destroy
 * fails: erasing the rows afterwards would orphan the container for good.
 */
export async function destroySpaceComputers(
  deps: Deps,
  spaceIds: string[],
  operation: string,
): Promise<void> {
  const failures: string[] = [];
  for (const computer of await computersIn(deps.prisma, spaceIds)) {
    try {
      await deps.sandbox.destroy(toComputerRef(computer), context(operation, computer.userId));
      await deps.prisma.computer.update({
        where: { id: computer.id },
        data: { providerRef: null, state: "stopped", screenUrl: null, ...RELEASED },
      });
    } catch (error) {
      failures.push(`${computer.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Could not destroy Computers (${failures.join("; ")})`);
  }
}

/** Destroy a person's Computers in their personal spaces: used by account deletion. */
export async function destroyPersonalComputers(deps: Deps, userId: string): Promise<void> {
  const personal = await personalOrganizations(deps.prisma, userId);
  await destroySpaceComputers(
    deps,
    personal.flatMap((organization) => organization.spaceIds),
    `account-delete:${userId}`,
  );
}

/** Destroy the Computers of quarantined organizations, then delete them. */
export async function purgeQuarantinedOrganizations(
  deps: Deps,
  organizations: Array<{ id: string; spaces: Array<{ id: string }> }>,
  operation = "quarantine-purge",
): Promise<void> {
  for (const organization of organizations) {
    await destroySpaceComputers(
      deps,
      organization.spaces.map((space) => space.id),
      operation,
    );
    await deleteOrganizations(deps.prisma, [organization.id]);
  }
}

let lastMaintenance = 0;
const MAINTENANCE_EVERY_MS = 60 * 60 * 1000;

/**
 * Hourly housekeeping for identity: purge quarantined spaces past their TTL (Computers first,
 * through the shared helper) and drop stale per-address counters. Safe to call on every
 * reconciliation tick; it only works once an hour.
 */
export async function identityMaintenance(deps: Deps, now = Date.now()): Promise<void> {
  if (now - lastMaintenance < MAINTENANCE_EVERY_MS) return;
  lastMaintenance = now;
  const expired = await quarantinedOrganizationsToPurge(deps.prisma, {
    olderThan: new Date(now - QUARANTINE_TTL_MS),
  });
  try {
    await purgeQuarantinedOrganizations(deps, expired);
    if (expired.length > 0) {
      getLogger().warn("purged quarantined spaces past their TTL", {
        "identity.purged_organizations": expired.length,
      });
    }
  } finally {
    await purgeStaleEmailQuota(deps.prisma, now);
  }
}

/** Test seam: forget the hourly throttle. */
export function resetIdentityMaintenance(): void {
  lastMaintenance = 0;
}
