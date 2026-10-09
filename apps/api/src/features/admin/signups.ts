// Who may join, and who is waiting. Deployment owner only; the owner check is the same one
// `deployment.update` uses. Approval is the moment a pending account first gets a space.

import type { OmnigentClientConfig } from "@nova/adapters";
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
import { getLogger } from "@nova/logging";
import { ORPCError } from "@orpc/server";
import type { RouterDeps } from "../../routers/context.js";
import { resetEngineAccount, setEngineAccountSuspended } from "./service.js";

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
  const keptBy = new Set(
    (
      await deps.prisma.organization.findMany({
        where: { quarantinedFromUserId: { in: users.map((user) => user.id) } },
        select: { quarantinedFromUserId: true },
      })
    ).map((organization) => organization.quarantinedFromUserId),
  );
  // Minimal evidence for "is this the same person": when the space began, when it was last used,
  // and how many Muses it holds.
  const evidence = new Map<string, PendingSignup["previousSpace"]>();
  for (const user of users.filter((candidate) => keptBy.has(candidate.id))) {
    const [spaces, lastRun, muses] = await Promise.all([
      deps.prisma.space.aggregate({
        where: { organization: { quarantinedFromUserId: user.id } },
        _min: { createdAt: true },
      }),
      deps.prisma.run.findFirst({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      }),
      deps.prisma.bot.count({ where: { userId: user.id, archivedAt: null } }),
    ]);
    evidence.set(user.id, {
      createdAt: (spaces._min.createdAt ?? new Date(0)).toISOString(),
      lastActive: lastRun?.createdAt.toISOString() ?? null,
      muses,
    });
  }
  return users.map((user) => ({
    previousSpace: evidence.get(user.id) ?? null,
    userId: user.id,
    email: user.email,
    name: user.name,
    emailVerified: user.emailVerified,
    createdAt: user.createdAt.toISOString(),
  }));
}

/**
 * An account whose space was quarantined had its engine account paused (flag on the user row).
 * Resolve that flag: `resume` for a confirmed restore, `reset` for anything else, which wipes the
 * engine account so the earlier holder's memory and schedules cannot reach a clean space. A
 * missing engine or owner is logged and the flag cleared (nothing to reset); an engine refusal
 * throws so the admin sees it and the flag stays for the retry.
 */
async function settleEngineAccount(
  deps: SignupsDeps,
  engine: OmnigentClientConfig | undefined,
  userId: string,
  how: "resume" | "reset",
): Promise<void> {
  const user = await deps.prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, engineQuarantinePaused: true },
  });
  if (!user?.engineQuarantinePaused) return;
  const outcome =
    how === "resume"
      ? await setEngineAccountSuspended(deps, engine, user.email, false)
      : await resetEngineAccount(deps, engine, user.email);
  if (outcome !== "done") {
    getLogger().warn(`engine account not ${how === "resume" ? "resumed" : "reset"}: ${outcome}`, {
      "user.id": userId,
    });
  }
  await deps.prisma.user.update({ where: { id: userId }, data: { engineQuarantinePaused: false } });
}

export async function approveSignup(
  deps: SignupsDeps,
  actor: Actor,
  userId: string,
  engine?: OmnigentClientConfig,
): Promise<{ ok: true }> {
  assertOwner(actor);
  const waiting = await deps.prisma.user.findFirst({
    where: { id: userId, status: "pending" },
    select: { id: true },
  });
  if (!waiting) throw new ORPCError("NOT_FOUND", { message: "Not waiting for approval" });
  // A clean approval after a quarantine starts the engine account over (before access opens).
  await settleEngineAccount(deps, engine, userId, "reset");
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
 * The admin has confirmed this is the same person as before: re-attach the kept space, resume
 * their engine account, and let them in. Keys, connections and messaging links were stripped and
 * stay gone; routines stay off.
 */
export async function restoreSignup(
  deps: SignupsDeps,
  actor: Actor,
  userId: string,
  engine?: OmnigentClientConfig,
): Promise<{ ok: true }> {
  assertOwner(actor);
  const waiting = await deps.prisma.user.findFirst({
    where: { id: userId, status: "pending" },
    select: { id: true },
  });
  if (!waiting) throw new ORPCError("NOT_FOUND", { message: "Not waiting for approval" });
  // Resume the engine account first: if the engine refuses, the person stays pending with the
  // flag set and the space still kept, and the restore can simply be retried.
  const kept = await quarantinedOrganizationsToPurge(deps.prisma, { userId });
  if (kept.length === 0) {
    throw new ORPCError("NOT_FOUND", { message: "No previous space is kept" });
  }
  await settleEngineAccount(deps, engine, userId, "resume");
  if ((await restoreQuarantinedSpaces(deps.prisma, userId)) === 0) {
    throw new ORPCError("NOT_FOUND", { message: "No previous space is kept" });
  }
  await deps.prisma.user.updateMany({
    where: { id: userId, status: "pending" },
    data: { status: "active" },
  });
  return { ok: true as const };
}

/**
 * Purge the kept space now: Computers are destroyed first, then the records go, and the engine
 * account is reset so its context does not outlive the space.
 */
export async function discardSignup(
  deps: SignupsDeps,
  actor: Actor,
  userId: string,
  engine?: OmnigentClientConfig,
): Promise<{ ok: true }> {
  assertOwner(actor);
  const organizations = await quarantinedOrganizationsToPurge(deps.prisma, { userId });
  if (organizations.length === 0) {
    throw new ORPCError("NOT_FOUND", { message: "No previous space is kept" });
  }
  const removed = await purgeQuarantinedOrganizations(
    deps,
    organizations,
    `quarantine-discard:${userId}`,
  );
  if (removed.length !== organizations.length) {
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "Some of it could not be removed yet. Try again.",
    });
  }
  await settleEngineAccount(deps, engine, userId, "reset");
  return { ok: true as const };
}
