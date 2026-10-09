import { randomBytes } from "node:crypto";
import { ACTIVE_RUN_STATUSES } from "@nova/core";
import type { PrismaClient } from "./client.js";

/** How long a quarantined space is kept for an admin before it is purged. */
export const QUARANTINE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Organizations where this person is the only member. */
export async function personalOrganizations(
  prisma: PrismaClient,
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
 * work, and every membership. The organization is flagged and renamed (so a fresh approval
 * creates a clean space rather than rejoining it) and kept for an admin to restore or discard.
 * Computers are stopped by the caller before this runs.
 */
export async function quarantineUserSpaces(
  prisma: PrismaClient,
  userId: string,
  now = new Date(),
): Promise<{ organizationIds: string[]; spaceIds: string[] }> {
  const personal = await personalOrganizations(prisma, userId);
  const organizationIds = personal.map((organization) => organization.id);
  const spaceIds = personal.flatMap((organization) => organization.spaceIds);
  await prisma.$transaction([
    prisma.run.updateMany({
      where: { userId, status: { in: [...ACTIVE_RUN_STATUSES] } },
      data: { status: "cancelled", completedAt: now, leaseOwner: null, leaseExpiresAt: null },
    }),
    prisma.routine.updateMany({ where: { userId }, data: { active: false, nextRunAt: null } }),
    prisma.messagingIdentity.deleteMany({ where: { userId } }),
    prisma.messagingLinkCode.deleteMany({ where: { userId } }),
    prisma.userModelCredential.deleteMany({ where: { userId } }),
    prisma.userVoiceCredential.deleteMany({ where: { userId } }),
    prisma.mcpOAuthSession.deleteMany({ where: { userId } }),
    prisma.mcpServer.deleteMany({ where: { userId } }),
    prisma.connection.deleteMany({ where: { userId } }),
    prisma.secret.deleteMany({ where: { userId } }),
    prisma.botSecret.deleteMany({ where: { userId } }),
    prisma.agentSecret.deleteMany({ where: { createdByUserId: userId } }),
    prisma.actionApprovalRule.deleteMany({ where: { createdByUserId: userId } }),
    prisma.actionAutoReviewPreference.deleteMany({ where: { userId } }),
    prisma.aiDataConsent.deleteMany({ where: { userId } }),
    // Memberships in any organization, shared ones too: nothing the earlier holder was part of
    // stays reachable. (Shared organizations cannot be joined in v1; this keeps that true later.)
    prisma.member.deleteMany({ where: { userId } }),
  ]);
  for (const organizationId of organizationIds) {
    await prisma.organization.update({
      where: { id: organizationId },
      data: {
        quarantinedFromUserId: userId,
        quarantinedAt: now,
        slug: `quarantine-${organizationId}-${randomBytes(3).toString("hex")}`,
      },
    });
  }
  return { organizationIds, spaceIds };
}

export async function quarantinedOrganizationsOf(prisma: PrismaClient, userId: string) {
  return prisma.organization.findMany({
    where: { quarantinedFromUserId: userId },
    select: { id: true, spaces: { select: { id: true } } },
  });
}

/**
 * Give the previous spaces back to the person an admin has confirmed. Keys, connections and
 * messaging links were stripped and are not restored; routines stay off until re-enabled.
 */
export async function restoreQuarantinedSpaces(
  prisma: PrismaClient,
  userId: string,
): Promise<number> {
  const organizations = await quarantinedOrganizationsOf(prisma, userId);
  for (const organization of organizations) {
    const stamp = new Date();
    await prisma.member.createMany({
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
    await prisma.spaceMember.createMany({
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
    const taken = await prisma.organization.findUnique({ where: { slug }, select: { id: true } });
    await prisma.organization.update({
      where: { id: organization.id },
      data: { quarantinedFromUserId: null, quarantinedAt: null, ...(taken ? {} : { slug }) },
    });
  }
  return organizations.length;
}

/** Quarantined organizations past their TTL (or all of one person's, when `userId` is given). */
export async function quarantinedOrganizationsToPurge(
  prisma: PrismaClient,
  options: { olderThan?: Date; userId?: string },
) {
  return prisma.organization.findMany({
    where: {
      quarantinedAt: options.olderThan ? { lt: options.olderThan } : { not: null },
      ...(options.userId ? { quarantinedFromUserId: options.userId } : {}),
    },
    select: { id: true, spaces: { select: { id: true } } },
  });
}

/** Delete organizations (and, by cascade, their spaces, bots, threads, memory and records). */
export async function deleteOrganizations(prisma: PrismaClient, organizationIds: string[]) {
  if (organizationIds.length === 0) return;
  await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } });
}

/** Counters older than this can never matter again. */
export async function purgeStaleEmailQuota(prisma: PrismaClient, now = Date.now()) {
  await prisma.$executeRaw`DELETE FROM email_quota WHERE "windowStart" < ${now - 2 * 24 * 60 * 60 * 1000}`;
}
