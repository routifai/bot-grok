// Who may join, and who is waiting. Deployment owner only; the owner check is the same one
// `deployment.update` uses. Approval is the moment a pending account first gets a space.

import { purgeQuarantinedOrganizations } from "@nova/adapters";
import {
  prismaEmailQuota,
  REJECTION_COOLDOWN_MS,
  rejectionKey,
  resolveSignupPolicy,
} from "@nova/auth";
import type { Actor, PendingSignup, SignupSettings } from "@nova/contracts";
import { parseAllowlist, parseDomains, signupNeedsEmailDelivery } from "@nova/core";
import {
  bootstrapUserSpace,
  quarantinedOrganizationsToPurge,
  restoreQuarantinedSpaces,
} from "@nova/db";
import { ORPCError } from "@orpc/server";
import type { RouterDeps } from "../../routers/context.js";

type SignupsDeps = Pick<RouterDeps, "prisma" | "identity" | "auth" | "sandbox">;

function assertOwner(actor: Actor): void {
  if (!actor.isDeploymentOwner) throw new ORPCError("FORBIDDEN");
}

const seed = (deps: SignupsDeps) => deps.identity?.signupPolicy ?? {};

export async function signupSettings(deps: SignupsDeps, actor: Actor): Promise<SignupSettings> {
  assertOwner(actor);
  return resolveSignupPolicy(deps.prisma, seed(deps));
}

export async function updateSignupSettings(
  deps: SignupsDeps,
  actor: Actor,
  input: Partial<SignupSettings>,
): Promise<SignupSettings> {
  assertOwner(actor);
  if (
    input.mode &&
    deps.identity?.production &&
    !deps.identity.emailDelivery &&
    signupNeedsEmailDelivery(input.mode)
  ) {
    throw new ORPCError("BAD_REQUEST", {
      message:
        "Email delivery is not configured, so new accounts cannot be verified. Set SMTP_URL or EMAIL_API_URL first.",
    });
  }
  const current = await resolveSignupPolicy(deps.prisma, seed(deps));
  const next = {
    mode: input.mode ?? current.mode,
    invites: input.invites ? parseAllowlist(input.invites.join(",")) : current.invites,
    domains: input.domains ? parseDomains(input.domains) : current.domains,
  };
  await deps.prisma.deploymentSettings.upsert({
    where: { id: "default" },
    create: {
      id: "default",
      ownerUserId: actor.userId,
      signupMode: next.mode,
      signupsEnabled: next.mode !== "closed",
      signupAllowlist: next.invites.join(","),
      signupDomains: next.domains.join(","),
      signupPolicyInitialized: true,
    },
    update: {
      signupMode: next.mode,
      signupsEnabled: next.mode !== "closed",
      signupAllowlist: next.invites.join(","),
      signupDomains: next.domains.join(","),
      signupPolicyInitialized: true,
    },
  });
  return next;
}

export async function pendingSignups(deps: SignupsDeps, actor: Actor): Promise<PendingSignup[]> {
  assertOwner(actor);
  const users = await deps.prisma.user.findMany({
    // Unverified rows are listed too: with no mail provider nobody has proved a mailbox, and an
    // admin needs to see (and be able to remove) a squatted address.
    where: { status: "pending" },
    orderBy: { createdAt: "asc" },
    select: { id: true, email: true, name: true, emailVerified: true, createdAt: true },
  });
  const kept = new Set(
    (
      await deps.prisma.organization.findMany({
        where: { quarantinedFromUserId: { in: users.map((user) => user.id) } },
        select: { quarantinedFromUserId: true },
      })
    ).map((organization) => organization.quarantinedFromUserId),
  );
  return users.map((user) => ({
    quarantined: kept.has(user.id),
    userId: user.id,
    email: user.email,
    name: user.name,
    emailVerified: user.emailVerified,
    createdAt: user.createdAt.toISOString(),
  }));
}

export async function approveSignup(
  deps: SignupsDeps,
  actor: Actor,
  userId: string,
): Promise<{ ok: true }> {
  assertOwner(actor);
  const claimed = await deps.prisma.user.updateMany({
    where: { id: userId, status: "pending" },
    data: { status: "active" },
  });
  if (claimed.count !== 1)
    throw new ORPCError("NOT_FOUND", { message: "Not waiting for approval" });
  // The first and only moment this person gets an organization, a space and (later) a Computer.
  await bootstrapUserSpace(deps.prisma, { id: userId }, seed(deps), {
    claimDeploymentOwner: false,
  });
  return { ok: true as const };
}

/**
 * Reject a waiting signup. A person who proved their mailbox is suspended, so the same address
 * cannot queue up again. An unproven address may be someone squatting on another person's
 * email, so that account is removed through Better Auth (sessions, accounts, user) and the real
 * owner can register; the address then cools down for a day so it cannot be re-queued at once.
 */
export async function rejectSignup(
  deps: SignupsDeps,
  actor: Actor,
  userId: string,
): Promise<{ ok: true }> {
  assertOwner(actor);
  const user = await deps.prisma.user.findFirst({
    where: { id: userId, status: "pending" },
    select: { id: true, email: true, emailVerified: true },
  });
  if (!user) throw new ORPCError("NOT_FOUND", { message: "Not waiting for approval" });
  if (user.emailVerified) {
    await deps.prisma.user.updateMany({
      where: { id: user.id, status: "pending" },
      data: { status: "suspended" },
    });
  } else {
    await (await deps.auth.$context).internalAdapter.deleteUser(user.id);
    await prismaEmailQuota(deps.prisma).fail(rejectionKey(user.email), REJECTION_COOLDOWN_MS);
  }
  return { ok: true as const };
}

/**
 * The admin has confirmed this is the same person as before: re-attach the kept space and let
 * them in. Keys, connections and messaging links were stripped and stay gone; routines stay off.
 */
export async function restoreSignup(
  deps: SignupsDeps,
  actor: Actor,
  userId: string,
): Promise<{ ok: true }> {
  assertOwner(actor);
  const waiting = await deps.prisma.user.findFirst({
    where: { id: userId, status: "pending" },
    select: { id: true },
  });
  if (!waiting) throw new ORPCError("NOT_FOUND", { message: "Not waiting for approval" });
  if ((await restoreQuarantinedSpaces(deps.prisma, userId)) === 0) {
    throw new ORPCError("NOT_FOUND", { message: "No previous space is kept" });
  }
  await deps.prisma.user.updateMany({
    where: { id: userId, status: "pending" },
    data: { status: "active" },
  });
  return { ok: true as const };
}

/** Purge the kept space now: Computers are destroyed first, then the records go. */
export async function discardSignup(
  deps: SignupsDeps,
  actor: Actor,
  userId: string,
): Promise<{ ok: true }> {
  assertOwner(actor);
  const organizations = await quarantinedOrganizationsToPurge(deps.prisma, { userId });
  if (organizations.length === 0) {
    throw new ORPCError("NOT_FOUND", { message: "No previous space is kept" });
  }
  await purgeQuarantinedOrganizations(deps, organizations, `quarantine-discard:${userId}`);
  return { ok: true as const };
}
