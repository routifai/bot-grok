import { randomBytes } from "node:crypto";
import { ACTIVE_RUN_STATUSES } from "@nova/core";
import type { PrismaClient } from "./client.js";

/** How long a quarantined space is kept for an admin before it is purged. */
export const QUARANTINE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Organizations where this person is the only member. */
export async function personalOrganizations(
  prisma: Pick<PrismaClient, "member">,
  userId: string,
): Promise<Array<{ id: string; spaceIds: string[] }>> {
  const memberships = await prisma.member.findMany({
    where: { userId },
    select: {
      organizationId: true,
      organization: {
        select: { members: { select: { userId: true } }, spaces: { select: { id: true } } },
      },
    },
  });
  return memberships
    .filter(({ organization }) => organization.members.every((member) => member.userId === userId))
    .map(({ organizationId, organization }) => ({
      id: organizationId,
      spaceIds: organization.spaces.map((space) => space.id),
    }));
}

/**
 * A mailbox was proved on an account that had used a space before anyone could prove it. Strip
 * everything that grants access or sends data out, and detach the personal organization instead
 * of deleting it: credentials and keys, messaging identities and link codes, connections,
 * secrets, MCP servers and OAuth sessions, approval rules and consent, scheduled and in-flight
 * work, live screen links (the screen generations are bumped, so no old link survives even a
 * restore), and every membership. The organization is flagged and renamed (so a fresh approval
 * creates a clean space rather than rejoining it) and kept for an admin to restore or discard.
 * It all happens in one transaction: either the space is fully detached and flagged, or nothing
 * changed. Computers are stopped by the caller before this runs.
 */
export async function quarantineUserSpaces(
  prisma: PrismaClient,
  userId: string,
  now = new Date(),
): Promise<{ organizationIds: string[]; spaceIds: string[] }> {
  return prisma.$transaction(async (tx) => {
    const personal = await personalOrganizations(tx, userId);
    const organizationIds = personal.map((organization) => organization.id);
    const spaceIds = personal.flatMap((organization) => organization.spaceIds);
    await tx.run.updateMany({
      where: { userId, status: { in: [...ACTIVE_RUN_STATUSES] } },
      data: { status: "cancelled", completedAt: now, leaseOwner: null, leaseExpiresAt: null },
    });
    await tx.routine.updateMany({ where: { userId }, data: { active: false, nextRunAt: null } });
    await tx.messagingIdentity.deleteMany({ where: { userId } });
    await tx.messagingLinkCode.deleteMany({ where: { userId } });
    await tx.userModelCredential.deleteMany({ where: { userId } });
    await tx.userVoiceCredential.deleteMany({ where: { userId } });
    await tx.mcpOAuthSession.deleteMany({ where: { userId } });
    await tx.mcpServer.deleteMany({ where: { userId } });
    await tx.connection.deleteMany({ where: { userId } });
    await tx.secret.deleteMany({ where: { userId } });
    await tx.botSecret.deleteMany({ where: { userId } });
    await tx.agentSecret.deleteMany({ where: { createdByUserId: userId } });
    await tx.actionApprovalRule.deleteMany({ where: { createdByUserId: userId } });
    await tx.actionAutoReviewPreference.deleteMany({ where: { userId } });
    await tx.aiDataConsent.deleteMany({ where: { userId } });
    // Live screen links carry the generations; bumping them kills every link issued before now.
    await tx.bot.updateMany({
      where: { spaceId: { in: spaceIds } },
      data: { screenGeneration: { increment: 1 } },
    });
    await tx.computer.updateMany({
      where: { spaceId: { in: spaceIds } },
      data: { screenGeneration: { increment: 1 }, screenUrl: null },
    });
    for (const organizationId of organizationIds) {
      await tx.organization.update({
        where: { id: organizationId },
        data: {
          quarantinedFromUserId: userId,
          quarantinedAt: now,
          slug: `quarantine-${organizationId}-${randomBytes(3).toString("hex")}`,
        },
      });
    }
    // Memberships in any organization, shared ones too: nothing the earlier holder was part of
    // stays reachable. (Shared organizations cannot be joined in v1; this keeps that true later.)
    await tx.member.deleteMany({ where: { userId } });
    await tx.user.update({ where: { id: userId }, data: { engineQuarantinePaused: true } });
    return { organizationIds, spaceIds };
  });
}

export async function quarantinedOrganizationsOf(prisma: PrismaClient, userId: string) {
  return prisma.organization.findMany({
    where: { quarantinedFromUserId: userId },
    select: { id: true, spaces: { select: { id: true } } },
  });
}

/**
 * Give the previous spaces back to the person an admin has confirmed. Each organization is
 * claimed with a conditional update first, so a purge that got there first wins and a restore
 * never half-applies. Keys, connections and messaging links were stripped and are not restored;
 * routines stay off until re-enabled.
 */
export async function restoreQuarantinedSpaces(
  prisma: PrismaClient,
  userId: string,
): Promise<number> {
  const organizations = await quarantinedOrganizationsOf(prisma, userId);
  let restored = 0;
  for (const organization of organizations) {
    const done = await prisma.$transaction(async (tx) => {
      const claimed = await tx.organization.updateMany({
        where: {
          id: organization.id,
          quarantinedFromUserId: userId,
          quarantinedAt: { not: null },
          quarantinePurgeStartedAt: null,
        },
        data: { quarantinedFromUserId: null, quarantinedAt: null },
      });
      if (claimed.count !== 1) return false;
      const stamp = new Date();
      await tx.member.createMany({
        data: [
          {
            id: randomBytes(16).toString("hex"),
            organizationId: organization.id,
            userId,
            role: "owner",
            createdAt: stamp,
          },
        ],
        skipDuplicates: true,
      });
      await tx.spaceMember.createMany({
        data: organization.spaces.map((space) => ({
          id: randomBytes(16).toString("hex"),
          spaceId: space.id,
          organizationId: organization.id,
          userId,
          role: "owner",
          createdAt: stamp,
        })),
        skipDuplicates: true,
      });
      const slug = `user-${userId.slice(0, 12)}`;
      const taken = await tx.organization.findUnique({ where: { slug }, select: { id: true } });
      if (!taken) await tx.organization.update({ where: { id: organization.id }, data: { slug } });
      return true;
    });
    if (done) restored += 1;
  }
  return restored;
}

/** A purge that began longer ago than this is presumed dead and may be taken again. */
const PURGE_CLAIM_STALE_MS = 15 * 60 * 1000;

/**
 * Mark a quarantined organization as being purged, so a restore can no longer take it. The
 * former owner stays recorded: a retried discard still finds the space. False when it is no
 * longer quarantined (a restore got there first) or another purge is working on it. A claim older
 * than 15 minutes is presumed dead and taken again.
 */
export async function claimQuarantinedForPurge(
  prisma: PrismaClient,
  organizationId: string,
  now = new Date(),
): Promise<boolean> {
  const claimed = await prisma.organization.updateMany({
    where: {
      id: organizationId,
      quarantinedAt: { not: null },
      OR: [
        { quarantinePurgeStartedAt: null },
        { quarantinePurgeStartedAt: { lt: new Date(now.getTime() - PURGE_CLAIM_STALE_MS) } },
      ],
    },
    data: { quarantinePurgeStartedAt: now },
  });
  return claimed.count === 1;
}

/** A purge failed: let a retry (or a restore) take the organization again at once. */
export async function releasePurgeClaim(prisma: PrismaClient, organizationId: string) {
  await prisma.organization.updateMany({
    where: { id: organizationId, quarantinedAt: { not: null } },
    data: { quarantinePurgeStartedAt: null },
  });
}

/** Quarantined organizations past their TTL (or all of one person's, when `userId` is given). */
export async function quarantinedOrganizationsToPurge(
  prisma: PrismaClient,
  options: { olderThan?: Date; userId?: string },
) {
  return prisma.organization.findMany({
    where: {
      quarantinedAt: options.olderThan ? { lt: options.olderThan } : { not: null },
      // A claimed-for-purge organization has no former owner left; the TTL sweep still takes it.
      ...(options.userId ? { quarantinedFromUserId: options.userId } : {}),
    },
    select: { id: true, spaces: { select: { id: true } } },
  });
}

/**
 * Delete quarantined organizations (and, by cascade, their spaces, bots, threads, memory and
 * records). Rechecks the flag in the delete itself, so one that was restored is never removed.
 */
export async function deleteQuarantinedOrganizations(
  prisma: PrismaClient,
  organizationIds: string[],
) {
  if (organizationIds.length === 0) return;
  await prisma.organization.deleteMany({
    where: { id: { in: organizationIds }, quarantinedAt: { not: null } },
  });
}

/** Counters older than this can never matter again. */
export async function purgeStaleEmailQuota(prisma: PrismaClient, now = Date.now()) {
  await prisma.$executeRaw`DELETE FROM email_quota WHERE "windowStart" < ${now - 2 * 24 * 60 * 60 * 1000}`;
}
