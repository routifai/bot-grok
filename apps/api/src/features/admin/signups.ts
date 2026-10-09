// Who may join, and who is waiting. Deployment owner only; the owner check is the same one
// `deployment.update` uses. Approval is the moment a pending account first gets a space.
import { resolveSignupPolicy } from "@nova/auth";
import type { Actor, PendingSignup, SignupSettings } from "@nova/contracts";
import { parseAllowlist, parseDomains, signupNeedsEmailDelivery } from "@nova/core";
import { bootstrapUserSpace } from "@nova/db";
import { ORPCError } from "@orpc/server";
import type { RouterDeps } from "../../routers/context.js";

type SignupsDeps = Pick<RouterDeps, "prisma" | "identity">;

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
      signupAllowlist: next.invites.join(","),
      signupDomains: next.domains.join(","),
      signupPolicyInitialized: true,
    },
    update: {
      signupMode: next.mode,
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
    // With mail delivery a pending person has proved their mailbox before they appear.
    where: { status: "pending", ...(deps.identity?.emailDelivery ? { emailVerified: true } : {}) },
    orderBy: { createdAt: "asc" },
    select: { id: true, email: true, name: true, createdAt: true },
  });
  return users.map((user) => ({
    userId: user.id,
    email: user.email,
    name: user.name,
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

/** Rejecting suspends rather than deletes, so the same address cannot queue up again. */
export async function rejectSignup(
  deps: SignupsDeps,
  actor: Actor,
  userId: string,
): Promise<{ ok: true }> {
  assertOwner(actor);
  const rejected = await deps.prisma.user.updateMany({
    where: { id: userId, status: "pending" },
    data: { status: "suspended" },
  });
  if (rejected.count !== 1)
    throw new ORPCError("NOT_FOUND", { message: "Not waiting for approval" });
  return { ok: true as const };
}
