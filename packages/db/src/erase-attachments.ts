import type { PrismaClient } from "./client.js";

/**
 * Delete everything a person attached to an account, while keeping the account row itself:
 * messaging identities and link codes, model and voice credentials, MCP servers and their OAuth
 * sessions, connections, secrets, approval rules and consent, and the personal organization with
 * its spaces, bots, threads, memory and Computers' records.
 *
 * Used when a mailbox is proved after the account was used unverified: nothing the earlier holder
 * attached may pass to the person who proved the address. Context they planted (memory, files,
 * instructions) is indistinguishable from the person's own, so it is removed, not quarantined.
 * Container-level cleanup (Computers) is the caller's, through the same hook account deletion uses.
 */
export async function eraseUserAttachments(prisma: PrismaClient, userId: string): Promise<void> {
  const memberships = await prisma.member.findMany({
    where: { userId },
    select: {
      organizationId: true,
      organization: { select: { members: { select: { userId: true } } } },
    },
  });
  const personalOrganizationIds = memberships
    .filter(({ organization }) => organization.members.every((member) => member.userId === userId))
    .map(({ organizationId }) => organizationId);
  await prisma.$transaction([
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
    prisma.botSection.deleteMany({ where: { userId } }),
    prisma.organization.deleteMany({ where: { id: { in: personalOrganizationIds } } }),
  ]);
}
