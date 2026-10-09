import type { AdapterContext, SandboxProvider } from "@nova/adapter-kit";
import {
  claimQuarantinedForPurge,
  deleteQuarantinedOrganizations,
  type PrismaClient,
  personalOrganizations,
  purgeStaleEmailQuota,
  QUARANTINE_TTL_MS,
  quarantinedOrganizationsToPurge,
  releasePurgeClaim,
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
 * Each Computer is stopped on its own, so one failure does not leave the others running; a
 * Computer that could not be stopped stays `running` in a quarantined organization, which is
 * exactly what the hourly job looks for and retries. Throws after trying all of them.
 */
export async function stopSpaceComputers(
  deps: Deps,
  spaceIds: string[],
  operation: string,
): Promise<void> {
  const failures: string[] = [];
  for (const computer of await computersIn(deps.prisma, spaceIds)) {
    if (!["running", "booting"].includes(computer.state)) continue;
    try {
      await deps.sandbox.stop(toComputerRef(computer), context(operation, computer.userId));
      await deps.prisma.computer.update({
        where: { id: computer.id },
        data: { state: "stopped", ...RELEASED },
      });
    } catch (error) {
      failures.push(`${computer.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length > 0) throw new Error(`Could not stop Computers (${failures.join("; ")})`);
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

/**
 * Purge quarantined organizations: claim each one (so a restore can no longer take it), destroy
 * its Computers, then delete it with a recheck. A failure on one organization is logged and the
 * rest still go; the failed one is retried by the next sweep. Returns the ids that were removed.
 */
export async function purgeQuarantinedOrganizations(
  deps: Deps,
  organizations: Array<{ id: string; spaces: Array<{ id: string }> }>,
  operation = "quarantine-purge",
): Promise<string[]> {
  const removed: string[] = [];
  for (const organization of organizations) {
    if (!(await claimQuarantinedForPurge(deps.prisma, organization.id))) continue;
    try {
      await destroySpaceComputers(
        deps,
        organization.spaces.map((space) => space.id),
        operation,
      );
      await deleteQuarantinedOrganizations(deps.prisma, [organization.id]);
      removed.push(organization.id);
    } catch (error) {
      getLogger().error("could not purge a quarantined space; it will be retried", error, {
        "identity.organization": organization.id,
      });
      await releasePurgeClaim(deps.prisma, organization.id).catch(() => undefined);
    }
  }
  return removed;
}

/** Stop Computers still running in quarantined organizations (an earlier stop failed). */
export async function retryQuarantinedStops(deps: Deps): Promise<void> {
  const stragglers = await deps.prisma.computer.findMany({
    where: {
      providerRef: { not: null },
      state: { in: ["running", "booting"] },
      space: { organization: { quarantinedAt: { not: null } } },
    },
    select: { spaceId: true },
  });
  for (const spaceId of new Set(stragglers.map((computer) => computer.spaceId))) {
    await stopSpaceComputers(deps, [spaceId], "quarantine-stop-retry").catch((error) =>
      getLogger().error("could not stop a quarantined Computer; will retry", error),
    );
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
  try {
    await retryQuarantinedStops(deps);
    const expired = await quarantinedOrganizationsToPurge(deps.prisma, {
      olderThan: new Date(now - QUARANTINE_TTL_MS),
    });
    const removed = await purgeQuarantinedOrganizations(deps, expired);
    if (removed.length > 0) {
      getLogger().warn("purged quarantined spaces past their TTL", {
        "identity.purged_organizations": removed.length,
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
