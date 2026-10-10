import { createHash, timingSafeEqual } from "node:crypto";
import type { TransactionalEmailProvider } from "@nova/adapter-kit";
import {
  admitSignup,
  ipPrefix,
  isHostedDeployment,
  isMessagingEmail,
  parseAllowlist,
  parseDomains,
  parseSignupMode,
  quotaEmailKey,
  type SignupPolicy,
  type SignupPolicyEnv,
  signupNeedsEmailDelivery,
  signupPolicyFromEnv,
  unverifiedAccessAllowed,
} from "@nova/core";
import {
  bootstrapUserSpace,
  type PrismaClient,
  personalOrganizations,
  quarantineUserSpaces,
} from "@nova/db";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError, createAuthMiddleware, getIP, getSessionFromCtx } from "better-auth/api";
import { bearer, emailOTP, organization } from "better-auth/plugins";
import { type EmailQuota, prismaEmailQuota } from "./email-quota.js";
import { codeEmail, OTP_EXPIRES_MINUTES, OTP_LENGTH, passwordResetEmail } from "./emails.js";
import { OIDC_PROVIDER_ID, type OidcConfig, oidcPlugin } from "./oidc.js";

export { isHostedDeployment } from "@nova/core";
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
  /** Destroys what an account owns outside the database (bots, Computers) before it is deleted. */
  beforeDeleteUser?: (userId: string) => Promise<void>;
  /** Stops (never destroys) the Computers in a space about to be quarantined. */
  beforeQuarantine?: (userId: string, spaceIds: string[]) => Promise<void>;
  /** Runs after a space was quarantined: stop engine-side work, log it for the admin. */
  afterQuarantine?: (info: {
    userId: string;
    email: string;
    organizationIds: string[];
    stopFailed: boolean;
  }) => Promise<void>;
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
   * One-time operator secret that binds the deployment owner seat. While no owner exists, only a
   * sign-in presenting this token (header `x-owner-setup-token`) can claim it; a hosted
   * deployment with no owner requires it in every signup mode. Unset it once an owner exists.
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
      // A set SIGNUP_MODE is applied on every start (like SIGNUP_ALLOWLIST), so the operator's
      // environment decides; unset, the mode the owner chose in Settings stands.
      mode: parseSignupMode(env.signupMode) ?? settings.signupMode,
      invites: parseAllowlist(settings.signupAllowlist),
      domains: parseDomains(settings.signupDomains),
    };
  }
  return signupPolicyFromEnv(env);
}

/**
 * Startup check. A hosted deployment must be able to prove the mailbox of anyone it admits on
 * their own (invite, domain, open), must be able to tell clients apart for rate limits, and must
 * bind its first owner to an operator secret. It never honors the local-development exemption.
 */
export function assertIdentityConfig(
  env: Pick<AuthEnv, "allowUnverifiedEmail" | "ownerSetupToken"> & {
    hosted: boolean;
    hasEmail: boolean;
    ownerExists?: boolean;
    clientIpConfigured?: boolean;
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
  if (env.clientIpConfigured === false) {
    throw new Error(
      "A hosted deployment needs AUTH_TRUSTED_PROXIES or AUTH_CLIENT_IP_HEADER so rate limits see real client addresses. The header must be set or overwritten by your edge, never passed through from clients.",
    );
  }
  if (policy.mode !== "closed" && env.ownerExists === false && !env.ownerSetupToken) {
    throw new Error(
      "A hosted deployment with no owner needs OWNER_SETUP_TOKEN (a one-time secret entered at sign-up to claim the owner seat). Unset it once an owner exists.",
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

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Per-address caps on top of the per-IP limiter. Sends are counted per (address, client network)
 * with a looser cap per address overall, so one person cannot exhaust another's mailbox from a
 * single network, yet a flood from many networks still stops. Password and code attempts count
 * only failures, in short windows: a lock that lifts itself in minutes, never a day-long lockout.
 */
const SEND_PATHS = new Set([
  "/email-otp/send-verification-otp",
  "/sign-up/email",
  "/request-password-reset",
  "/email-otp/request-password-reset",
]);
const FAIL_PATHS = new Set([
  "/sign-in/email",
  "/sign-in/email-otp",
  "/email-otp/verify-email",
  "/email-otp/check-verification-otp",
  "/email-otp/reset-password",
]);
const SEND_LIMITS = { network: { hour: 5, day: 20 }, address: { hour: 20, day: 60 } };
const FAIL_LIMITS = { window: 15 * MINUTE, network: 8, address: 40 };

/** How long an address an admin removed from the approval queue cannot queue up again. */
export const REJECTION_COOLDOWN_MS = DAY;
export const rejectionKey = (email: string) => `rejected:${quotaEmailKey(email)}`;

export function createAuth(prisma: PrismaClient, env: AuthEnv) {
  const hosted = isHostedDeployment(env);
  // Mailbox proof is required whenever mail can be sent.
  const verifyEmail = Boolean(env.email);
  // With no mail provider, unverified accounts are usable only where an admin vets every account
  // (approval mode) or on a personal install that opted in. Same rule as `userMayAct`.
  const unverifiedAllowed = (policy: SignupPolicy) =>
    unverifiedAccessAllowed({
      hasEmailDelivery: Boolean(env.email),
      mode: policy.mode,
      devFlagAllowed: env.allowUnverifiedEmail === true && !hosted,
    });
  const quota = env.emailQuota ?? prismaEmailQuota(prisma);
  const sendCode = async (email: string, otp: string, type: CodeType) => {
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
        if (await quota.blocked(rejectionKey(email), REJECTION_COOLDOWN_MS, 1)) return;
      }
    }
    // Keep the response timing generic. Production providers track and retry the promise,
    // while the composition root drains accepted delivery during graceful shutdown.
    void env.email?.send(codeEmail(email, otp, type)).catch((error) => env.onEmailError?.(error));
  };
  /**
   * Claim the deployment owner seat for a waiting account. Atomic, and only while the deployment
   * has no owner and no other active person; bound to the operator's setup token when one is set.
   * A hosted deployment always requires the token; otherwise a proven mailbox is enough.
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
    } else if (hosted || !env.email) {
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
  /**
   * A mailbox is being proved for an account that was not verified before. Whatever was attached
   * to it until now came from someone who had not proved the address: their password and sessions
   * go. If the account had been used (it has a space), the space is quarantined, not deleted: the
   * Computers stop, everything that grants access or sends data out is stripped, the organization
   * is detached and kept for an admin to restore or discard (purged after 30 days), and the
   * account returns to `pending`. A legitimate person approved before email existed can be
   * restored; a squatter's planted context never reaches a new space. The deployment owner is
   * exempt (their seat is bound to the operator's secret). The OIDC account is kept: the identity
   * provider vouches for that address. Better Auth's own code sign-in path deletes every account
   * first, so there the SSO account is already gone; only SSO sign-in reaches here with it intact.
   * Reset flows pass `keepCredential` for the password they have just set.
   */
  const proveMailbox = async (userId: string, options: { keepCredential?: boolean } = {}) => {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { emailVerified: true, status: true, email: true },
    });
    if (!user || user.emailVerified) return;
    const settings = await prisma.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { ownerUserId: true },
    });
    if (settings?.ownerUserId === userId) return;
    const kept = options.keepCredential ? ["credential", OIDC_PROVIDER_ID] : [OIDC_PROVIDER_ID];
    await prisma.account.deleteMany({ where: { userId, providerId: { notIn: kept } } });
    await prisma.session.deleteMany({ where: { userId } });
    const used = (await prisma.spaceMember.findFirst({ where: { userId } })) !== null;
    if (used) {
      const personal = await personalOrganizations(prisma, userId);
      let stopFailed = false;
      try {
        await env.beforeQuarantine?.(
          userId,
          personal.flatMap((organization) => organization.spaceIds),
        );
      } catch {
        // Signing in must not depend on the container provider being up; the failure is reported
        // below and the spaces are detached either way.
        stopFailed = true;
      }
      const { organizationIds } = await quarantineUserSpaces(prisma, userId);
      if (user.status === "active") {
        await prisma.user.update({ where: { id: userId }, data: { status: "pending" } });
      }
      await env.afterQuarantine?.({ userId, email: user.email, organizationIds, stopFailed });
    }
    // A session created while this ran must not survive it.
    await prisma.session.deleteMany({ where: { userId } });
  };
  const linkingTrusted = Boolean(env.oidc && (env.oidc.allowedDomains?.length ?? 0) > 0);
  const clientNetwork = (ctx: { request?: Request; context: { options: never } }) =>
    ipPrefix(ctx.request ? getIP(ctx.request, ctx.context.options) : null);
  return betterAuth({
    appName: "Nova",
    secret: env.secret,
    baseURL: env.baseURL,
    trustedOrigins: buildTrustedOrigins(env),
    database: prismaAdapter(prisma, { provider: "postgresql" }),
    // Linking is off unless the SSO connection is pinned to company domains. Then only that
    // provider may link to an existing person by email. The local row need not be verified:
    // an SSO sign-in is itself mailbox proof, and proving it voids whatever was attached before.
    account: {
      accountLinking: linkingTrusted
        ? {
            enabled: true,
            trustedProviders: [OIDC_PROVIDER_ID],
            requireLocalEmailVerified: false,
          }
        : { enabled: false, disableImplicitLinking: true },
    },
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
      // A reset is mailbox proof: void what was attached before it, keep the password just set,
      // and mark the address verified.
      onPasswordReset: async ({ user }) => {
        await proveMailbox(user.id, { keepCredential: true });
        await prisma.user.updateMany({
          where: { id: user.id, emailVerified: false },
          data: { emailVerified: true },
        });
      },
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
        const address = typeof ctx.body?.email === "string" ? quotaEmailKey(ctx.body.email) : null;
        if (address && (SEND_PATHS.has(ctx.path) || FAIL_PATHS.has(ctx.path))) {
          const network = clientNetwork(ctx as never);
          const tooMany = () =>
            new APIError("TOO_MANY_REQUESTS", { message: "Too many attempts. Try again later." });
          if (SEND_PATHS.has(ctx.path)) {
            const within =
              (await quota.consume(
                `send:h:${address}:${network}`,
                HOUR,
                SEND_LIMITS.network.hour,
              )) &&
              (await quota.consume(`send:d:${address}:${network}`, DAY, SEND_LIMITS.network.day)) &&
              (await quota.consume(`send:h:${address}`, HOUR, SEND_LIMITS.address.hour)) &&
              (await quota.consume(`send:d:${address}`, DAY, SEND_LIMITS.address.day));
            if (!within) throw tooMany();
          } else if (
            (await quota.blocked(
              `fail:${address}:${network}`,
              FAIL_LIMITS.window,
              FAIL_LIMITS.network,
            )) ||
            (await quota.blocked(`fail:${address}`, FAIL_LIMITS.window, FAIL_LIMITS.address))
          ) {
            throw tooMany();
          }
        }
        if (
          ctx.path === "/sign-up/email" &&
          address &&
          (await quota.blocked(rejectionKey(address), REJECTION_COOLDOWN_MS, 1))
        ) {
          // An admin removed this address from the queue a moment ago.
          throw new APIError("TOO_MANY_REQUESTS", { message: "Try again later." });
        }
        if (ctx.path === "/sign-up/email") {
          const policy = !env.email ? await resolveSignupPolicy(prisma, env) : undefined;
          if (policy && !unverifiedAllowed(policy)) {
            throw new APIError("BAD_REQUEST", {
              message: "Email delivery is not configured. Ask your administrator to set it up.",
            });
          }
          // With no mail to prove an address, "already registered" would tell anyone which
          // people use this deployment. Answer as if the signup is waiting for verification.
          if (policy && typeof ctx.body?.email === "string") {
            const existing = await ctx.context.internalAdapter.findUserByEmail(ctx.body.email);
            if (existing) return ctx.json({ token: null, user: null });
          }
        }
        const adapter = ctx.context.internalAdapter;
        return {
          context: {
            context: {
              internalAdapter: {
                ...adapter,
                // Authorize at lookup: bearer conversion happens after before
                // hooks, and auth mutations also read sessions through here.
                findSession: async (token: string) => {
                  const session = await adapter.findSession(token);
                  if (!session || isMessagingEmail(session.user.email)) return null;
                  if (statusOf(session.user) === "suspended") return null;
                  // Waiting accounts hold a session only for their own screen: not for
                  // organization data such as invitations.
                  if (
                    ctx.path.startsWith("/organization/") &&
                    statusOf(session.user) !== "active"
                  ) {
                    return null;
                  }
                  if (
                    !session.user.emailVerified &&
                    !unverifiedAllowed(await resolveSignupPolicy(prisma, env))
                  ) {
                    return null;
                  }
                  return session;
                },
                // Every way an address becomes verified (code, link, reset, SSO) comes through
                // here, keyed on the account itself: void what was attached before the proof.
                updateUser: async (userId: string, data: Record<string, unknown>) => {
                  if (data.emailVerified === true) await proveMailbox(userId);
                  return adapter.updateUser(userId, data);
                },
                updateUserByEmail: async (email: string, data: Record<string, unknown>) => {
                  if (data.emailVerified === true) {
                    const found = await adapter.findUserByEmail(email);
                    if (found) await proveMailbox(found.user.id);
                  }
                  return adapter.updateUserByEmail(email, data);
                },
              },
            },
          },
        };
      }),
      after: createAuthMiddleware(async (ctx) => {
        // Failed password and code attempts count against the address, in short windows.
        const address = typeof ctx.body?.email === "string" ? quotaEmailKey(ctx.body.email) : null;
        if (!address || !FAIL_PATHS.has(ctx.path)) return;
        const returned = ctx.context.returned as unknown;
        const failed =
          returned instanceof Error ||
          (returned instanceof Response && returned.status >= 400) ||
          (typeof returned === "object" &&
            returned !== null &&
            "status" in returned &&
            Number((returned as { status: unknown }).status) >= 400);
        if (!failed) return;
        const network = clientNetwork(ctx as never);
        await quota.fail(`fail:${address}:${network}`, FAIL_LIMITS.window);
        await quota.fail(`fail:${address}`, FAIL_LIMITS.window);
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
            const presented =
              ctx?.headers?.get(OWNER_SETUP_HEADER) ??
              ctx?.request?.headers.get(OWNER_SETUP_HEADER);
            let status = statusOf(user);
            if (status === "pending" && policy.mode === "approval") {
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
              // On a hosted deployment the first person to arrive does not become owner just by
              // being first: the setup token decides, whatever the signup mode.
              const mayClaimOwner =
                !hosted ||
                (Boolean(env.ownerSetupToken) &&
                  tokenMatches(presented, env.ownerSetupToken ?? ""));
              await bootstrapUserSpace(prisma, user, env, { claimDeploymentOwner: mayClaimOwner });
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
          before: async (user) => {
            if (user.email && isMessagingEmail(user.email)) {
              throw new APIError("BAD_REQUEST", { message: "Email is not available" });
            }
          },
        },
      },
      account: {
        create: {
          before: async (account, ctx) => {
            if (account.providerId !== OIDC_PROVIDER_ID || !ctx) return;
            const settings = await prisma.deploymentSettings.findUnique({
              where: { id: "default" },
              select: { ownerUserId: true },
            });
            if (settings?.ownerUserId !== account.userId) return;
            // The owner's seat is bound to the operator's secret, not to an email address, so a
            // provider sign-in never links to it implicitly. They link from inside their session.
            const session = await getSessionFromCtx(ctx).catch(() => null);
            if (session?.user.id !== account.userId) {
              throw new APIError("FORBIDDEN", { message: "Link this sign-in from your account" });
            }
          },
        },
      },
    },
  });
}

type CodeType = Parameters<typeof codeEmail>[2];

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
