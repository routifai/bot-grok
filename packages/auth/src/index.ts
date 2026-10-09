import { createHash, timingSafeEqual } from "node:crypto";
import type { TransactionalEmailProvider } from "@nova/adapter-kit";
import {
  admitSignup,
  isMessagingEmail,
  parseAllowlist,
  parseDomains,
  type SignupPolicy,
  type SignupPolicyEnv,
  signupNeedsEmailDelivery,
  signupPolicyFromEnv,
} from "@nova/core";
import { bootstrapUserSpace, type PrismaClient } from "@nova/db";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { bearer, emailOTP, organization } from "better-auth/plugins";
import { type EmailQuota, prismaEmailQuota } from "./email-quota.js";
import { codeEmail, OTP_EXPIRES_MINUTES, OTP_LENGTH, passwordResetEmail } from "./emails.js";
import { type OidcConfig, oidcPlugin } from "./oidc.js";

export type { EmailQuota } from "./email-quota.js";
export { memoryEmailQuota, prismaEmailQuota } from "./email-quota.js";
export { codeEmail, passwordResetEmail } from "./emails.js";
export type { OidcConfig } from "./oidc.js";
export { assertOidcConfig, OIDC_PROVIDER_ID, oidcLabel } from "./oidc.js";

/** Header an operator-issued owner setup token travels in (see `ownerSetupToken`). */
export const OWNER_SETUP_HEADER = "x-owner-setup-token";

export interface AuthEnv extends SignupPolicyEnv {
  secret: string;
  baseURL: string;
  webOrigin: string;
  extraOrigins?: string[];
  email?: TransactionalEmailProvider;
  onEmailError?: (error: unknown) => void;
  beforeDeleteUser?: (userId: string) => Promise<void>;
  /** A hosted `production` deployment disables the local-development escape hatch below. */
  nodeEnv?: string;
  /**
   * Personal or local install only, off by default: with no email provider, accounts are usable
   * without mailbox proof. Refused on a hosted deployment (see isHostedDeployment).
   */
  allowUnverifiedEmail?: boolean;
  /** One generic OIDC connection (Google Workspace, Entra, Okta, ...). */
  oidc?: OidcConfig;
  /**
   * One-time operator secret that binds the deployment owner seat. While no owner exists in
   * `approval` mode, only a sign-in presenting this token (header `x-owner-setup-token`) can
   * claim it. With no token and no email provider nobody can claim it.
   */
  ownerSetupToken?: string;
  /** Per-address send/verify caps; defaults to a database-backed counter. */
  emailQuota?: EmailQuota;
  /** Trusted reverse-proxy IPs/CIDRs so a forwarded chain resolves to the real client. */
  trustedProxies?: string[];
  /** A single header that carries the client IP (for platforms that set one). */
  clientIpHeader?: string;
  /** Force rate limiting on or off; defaults to on in production. */
  rateLimit?: boolean;
}

export async function resolveSignupPolicy(
  prisma: Pick<PrismaClient, "deploymentSettings">,
  env: SignupPolicyEnv,
): Promise<SignupPolicy> {
  const settings = await prisma.deploymentSettings.findUnique({
    where: { id: "default" },
    select: {
      signupMode: true,
      signupAllowlist: true,
      signupDomains: true,
      signupPolicyInitialized: true,
    },
  });
  if (settings?.signupPolicyInitialized) {
    return {
      mode: settings.signupMode,
      invites: parseAllowlist(settings.signupAllowlist),
      domains: parseDomains(settings.signupDomains),
    };
  }
  return signupPolicyFromEnv(env);
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * A production process that is reachable beyond this machine. A production build served only on
 * loopback (a local Docker install) is a personal install, not a hosted one. Hosted requires
 * NODE_ENV=production.
 */
export function isHostedDeployment(env: Pick<AuthEnv, "nodeEnv" | "webOrigin">): boolean {
  if (env.nodeEnv !== "production") return false;
  try {
    return !LOOPBACK_HOSTS.has(new URL(env.webOrigin).hostname);
  } catch {
    return true;
  }
}

/**
 * Startup check. A hosted deployment must be able to prove the mailbox of anyone it admits on
 * their own (invite, domain, open), and must be able to seat an owner in approval mode. It
 * never honors the local-development exemption.
 */
export function assertIdentityConfig(
  env: Pick<AuthEnv, "allowUnverifiedEmail" | "ownerSetupToken"> & {
    hosted: boolean;
    hasEmail: boolean;
    ownerExists?: boolean;
  },
  policy: SignupPolicy,
): void {
  if (!env.hosted) return;
  if (env.allowUnverifiedEmail) {
    throw new Error(
      "AUTH_ALLOW_UNVERIFIED_EMAIL is for local development and cannot run on a hosted deployment",
    );
  }
  if (!env.hasEmail && signupNeedsEmailDelivery(policy.mode)) {
    throw new Error(
      `Signup mode "${policy.mode}" needs email delivery to verify new accounts. Configure SMTP_URL or EMAIL_API_URL, or use the "approval" or "closed" mode.`,
    );
  }
  if (
    policy.mode === "approval" &&
    !env.hasEmail &&
    !env.ownerSetupToken &&
    env.ownerExists === false
  ) {
    throw new Error(
      "Approval mode with no email provider and no owner needs OWNER_SETUP_TOKEN, or nobody can be seated as owner.",
    );
  }
}

type UserStatus = "pending" | "active" | "suspended";

function statusOf(user: object): UserStatus {
  const status = (user as { status?: unknown }).status;
  return status === "pending" || status === "suspended" ? status : "active";
}

const digest = (value: string) => createHash("sha256").update(value).digest();

/** Constant-time token comparison. */
function tokenMatches(presented: string | null | undefined, expected: string): boolean {
  return typeof presented === "string" && timingSafeEqual(digest(presented), digest(expected));
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Per-address caps on top of the per-IP limiter, so one mailbox cannot be hammered from many IPs. */
const EMAIL_RULES: Record<string, { group: string; hour: number; day: number }> = {
  "/email-otp/send-verification-otp": { group: "otp-send", hour: 5, day: 20 },
  "/sign-in/email-otp": { group: "otp-verify", hour: 10, day: 30 },
  "/email-otp/verify-email": { group: "otp-verify", hour: 10, day: 30 },
  "/email-otp/check-verification-otp": { group: "otp-verify", hour: 10, day: 30 },
  "/sign-up/email": { group: "password", hour: 10, day: 40 },
  "/sign-in/email": { group: "password", hour: 10, day: 40 },
  "/request-password-reset": { group: "reset", hour: 5, day: 20 },
};

export function createAuth(prisma: PrismaClient, env: AuthEnv) {
  const hosted = isHostedDeployment(env);
  // Mailbox proof is required whenever mail can be sent.
  const verifyEmail = Boolean(env.email);
  // With no mail provider, unverified accounts are usable only where an admin vets every account
  // (approval mode) or on a personal install that opted in.
  const unverifiedAllowed = (policy: SignupPolicy) =>
    !env.email && (policy.mode === "approval" || (env.allowUnverifiedEmail === true && !hosted));
  const quota = env.emailQuota ?? prismaEmailQuota(prisma);
  const sendCode = async (email: string, otp: string, type: Parameters<typeof codeEmail>[2]) => {
    if (type === "sign-in") {
      // Do not mail a code to an address that could never get an account, and do not tell the
      // caller: the response is the same either way.
      const existing = await prisma.user.findFirst({
        where: { email: { equals: email, mode: "insensitive" } },
        select: { id: true },
      });
      if (!existing) {
        const admission = admitSignup(await resolveSignupPolicy(prisma, env), email);
        if (!admission.ok) return;
      }
    }
    // Keep the response timing generic. Production providers track and retry the promise,
    // while the composition root drains accepted delivery during graceful shutdown.
    void env.email?.send(codeEmail(email, otp, type)).catch((error) => env.onEmailError?.(error));
  };
  /**
   * Claim the deployment owner seat for a waiting account. Atomic, and only while the deployment
   * has no owner and no other active person; bound to the operator's setup token when one is set,
   * otherwise to a proven mailbox.
   */
  const claimOwnerSeat = async (user: { id: string }, presented: string | null | undefined) => {
    const settings = await prisma.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { ownerUserId: true },
    });
    if (!settings) return false;
    if (settings.ownerUserId) return settings.ownerUserId === user.id;
    if (env.ownerSetupToken) {
      if (!tokenMatches(presented, env.ownerSetupToken)) return false;
    } else if (!env.email) {
      return false;
    }
    const someoneElse = await prisma.user.findFirst({
      where: {
        status: "active",
        id: { not: user.id },
        NOT: { email: { endsWith: "@messaging.invalid", mode: "insensitive" } },
      },
      select: { id: true },
    });
    if (someoneElse) return false;
    const claimed = await prisma.deploymentSettings.updateMany({
      where: { id: "default", ownerUserId: null },
      data: { ownerUserId: user.id },
    });
    return claimed.count === 1;
  };
  return betterAuth({
    appName: "Nova",
    secret: env.secret,
    baseURL: env.baseURL,
    trustedOrigins: buildTrustedOrigins(env),
    database: prismaAdapter(prisma, { provider: "postgresql" }),
    // Never link a provider account to an existing person by email alone.
    account: { accountLinking: { disableImplicitLinking: true } },
    rateLimit: {
      enabled: env.rateLimit ?? env.nodeEnv === "production",
      // Shared by every API process, not a per-process memory bucket.
      storage: "database",
      window: 60,
      max: 100,
    },
    advanced: {
      ipAddress: {
        ...(env.clientIpHeader ? { ipAddressHeaders: [env.clientIpHeader] } : {}),
        ...(env.trustedProxies?.length ? { trustedProxies: env.trustedProxies } : {}),
      },
    },
    emailAndPassword: {
      enabled: true,
      // Signup policy is mutable deployment state, so the user-create hook enforces it
      // instead of freezing an environment value at process start.
      disableSignUp: false,
      requireEmailVerification: verifyEmail,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 60 * 60,
      sendResetPassword: env.email
        ? async ({ user, url }) => {
            void env.email
              ?.send(passwordResetEmail(user, url))
              .catch((error) => env.onEmailError?.(error));
          }
        : undefined,
    },
    emailVerification: {
      sendOnSignIn: true,
      autoSignInAfterVerification: true,
    },
    user: {
      additionalFields: {
        // Server-owned: never accepted from a signup body.
        status: { type: "string", defaultValue: "active", input: false },
      },
      deleteUser: {
        enabled: true,
        beforeDelete: async (user) => {
          await env.beforeDeleteUser?.(user.id);
          const memberships = await prisma.member.findMany({
            where: { userId: user.id },
            select: {
              organizationId: true,
              organization: { select: { members: { select: { userId: true } } } },
            },
          });
          const personalOrganizationIds = memberships
            .filter(({ organization }) =>
              organization.members.every((member) => member.userId === user.id),
            )
            .map(({ organizationId }) => organizationId);

          await prisma.$transaction([
            prisma.deploymentSettings.updateMany({
              where: { ownerUserId: user.id },
              data: { ownerUserId: null },
            }),
            // Messaging identities are deliberately FK-free, so clear them
            // here or the unique address would point at a deleted bot forever.
            prisma.messagingIdentity.deleteMany({
              where: { userId: user.id },
            }),
            prisma.organization.deleteMany({
              where: { id: { in: personalOrganizationIds } },
            }),
          ]);
        },
      },
    },
    plugins: [
      bearer(),
      organization({
        allowUserToCreateOrganization: false,
        creatorRole: "owner",
      }),
      ...oidcPlugin(env.oidc),
      ...(env.email
        ? [
            emailOTP({
              otpLength: OTP_LENGTH,
              expiresIn: OTP_EXPIRES_MINUTES * 60,
              allowedAttempts: 3,
              storeOTP: "hashed",
              overrideDefaultEmailVerification: true,
              sendVerificationOTP: async ({ email, otp, type }) => sendCode(email, otp, type),
            }),
          ]
        : []),
    ],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        for (const value of [ctx.body?.email, ctx.body?.newEmail]) {
          if (typeof value === "string" && isMessagingEmail(value)) {
            throw new APIError("BAD_REQUEST", { message: "Email is not available" });
          }
        }
        const rule = EMAIL_RULES[ctx.path];
        if (rule && typeof ctx.body?.email === "string") {
          const email = ctx.body.email.trim().toLowerCase();
          const allowed =
            (await quota.consume(`${rule.group}:h:${email}`, HOUR, rule.hour)) &&
            (await quota.consume(`${rule.group}:d:${email}`, DAY, rule.day));
          if (!allowed) {
            throw new APIError("TOO_MANY_REQUESTS", {
              message: "Too many attempts. Try again later.",
            });
          }
        }
        if (ctx.path === "/sign-up/email" && !env.email) {
          if (!unverifiedAllowed(await resolveSignupPolicy(prisma, env))) {
            throw new APIError("BAD_REQUEST", {
              message: "Email delivery is not configured. Ask your administrator to set it up.",
            });
          }
        }
        return {
          context: {
            context: {
              internalAdapter: {
                ...ctx.context.internalAdapter,
                // Authorize at lookup: bearer conversion happens after before
                // hooks, and auth mutations also read sessions through here.
                findSession: async (token: string) => {
                  const session = await ctx.context.internalAdapter.findSession(token);
                  if (!session || isMessagingEmail(session.user.email)) return null;
                  if (statusOf(session.user) === "suspended") return null;
                  if (
                    !session.user.emailVerified &&
                    !unverifiedAllowed(await resolveSignupPolicy(prisma, env))
                  ) {
                    return null;
                  }
                  return session;
                },
              },
            },
          },
        };
      }),
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session, ctx) => {
            // The auth adapter can still be inside the signup transaction.
            const user = await ctx?.context.internalAdapter.findUserById(session.userId);
            if (!user || isMessagingEmail(user.email)) {
              throw new APIError("FORBIDDEN", { message: "Email verification required" });
            }
            // Same answer for a suspended account as for any other refusal.
            if (statusOf(user) === "suspended") {
              throw new APIError("FORBIDDEN", { message: "Could not sign in" });
            }
            const policy = await resolveSignupPolicy(prisma, env);
            if (!user.emailVerified && !unverifiedAllowed(policy)) {
              throw new APIError("FORBIDDEN", { message: "Email verification required" });
            }
            let status = statusOf(user);
            if (status === "pending" && policy.mode === "approval") {
              const presented =
                ctx?.headers?.get(OWNER_SETUP_HEADER) ??
                ctx?.request?.headers.get(OWNER_SETUP_HEADER);
              if (await claimOwnerSeat(user, presented)) {
                await ctx?.context.internalAdapter.updateUser(user.id, { status: "active" });
                status = "active";
              }
            }
            // A pending account may sign in to see its waiting screen, but gets no space,
            // Computer or model access until an admin approves it.
            if (status === "pending") return;
            const membership = await prisma.spaceMember.findFirst({ where: { userId: user.id } });
            if (!membership) {
              const admission = admitSignup(policy, user.email);
              if (!admission.ok) throw new APIError("FORBIDDEN", { message: admission.message });
              await bootstrapUserSpace(prisma, user, env);
            }
          },
        },
      },
      user: {
        create: {
          before: async (user) => {
            if (isMessagingEmail(user.email)) {
              throw new APIError("BAD_REQUEST", { message: "Email is not available" });
            }
            // One choke point for every way in: password, email code, OIDC.
            const admission = admitSignup(await resolveSignupPolicy(prisma, env), user.email);
            if (!admission.ok) throw new APIError("BAD_REQUEST", { message: admission.message });
            return { data: { ...user, status: admission.status } };
          },
        },
        update: {
          before: async (user, ctx) => {
            if (user.email && isMessagingEmail(user.email)) {
              throw new APIError("BAD_REQUEST", { message: "Email is not available" });
            }
            // The moment a mailbox is proved, anything attached before the proof is void: a
            // squatter who registered this address with a password must not keep it. The proof
            // has already been checked; the new session is created after this update.
            const email = ctx?.body?.email;
            if (user.emailVerified === true && typeof email === "string") {
              const found = await ctx?.context.internalAdapter.findUserByEmail(email);
              if (found && !found.user.emailVerified) {
                await ctx?.context.internalAdapter.deleteAccounts(found.user.id);
                const sessions = await ctx?.context.internalAdapter.listSessions(found.user.id);
                await ctx?.context.internalAdapter.deleteSessions(
                  (sessions ?? []).map((existing) => existing.token),
                );
              }
            }
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

/** Assemble Better Auth trustedOrigins, adding localhost↔127.0.0.1 twins for loopback. */
export function buildTrustedOrigins(env: Pick<AuthEnv, "webOrigin" | "baseURL" | "extraOrigins">) {
  const configured = [env.webOrigin, env.baseURL, ...(env.extraOrigins ?? [])];
  const twins = [env.webOrigin, env.baseURL].flatMap(loopbackTwinOrigins);
  return [...new Set([...configured, ...twins])];
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

/** Same-scheme/port localhost and 127.0.0.1 variants when `origin` is loopback. */
function loopbackTwinOrigins(origin: string): string[] {
  try {
    const url = new URL(origin);
    if (!isLoopbackHost(url.hostname)) return [];
    const twins: string[] = [];
    for (const host of ["localhost", "127.0.0.1"] as const) {
      if (host === url.hostname) continue;
      const twin = new URL(origin);
      twin.hostname = host;
      twins.push(twin.origin);
    }
    return twins;
  } catch {
    return [];
  }
}

export const blockedAuthPaths = [
  "/organization/create",
  "/organization/invite",
  "/organization/accept-invitation",
  "/organization/reject-invitation",
  "/organization/remove-member",
  "/organization/update-member-role",
];
