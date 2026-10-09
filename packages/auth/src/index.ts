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
import { codeEmail, OTP_EXPIRES_MINUTES, OTP_LENGTH, passwordResetEmail } from "./emails.js";
import { type SocialConfig, socialProviders } from "./social.js";

export { codeEmail, passwordResetEmail } from "./emails.js";
export type { SocialConfig } from "./social.js";
export { socialProviderIds } from "./social.js";

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
   * Local development only, off by default: with no email provider, accounts are usable
   * without mailbox proof. Refused on a hosted deployment (see isHostedDeployment).
   */
  allowUnverifiedEmail?: boolean;
  social?: SocialConfig;
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
 * loopback (a local Docker install) is a personal install, not a hosted one.
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
 * Startup check. A hosted deployment that admits strangers must be able to prove their mailbox,
 * so it refuses to run an open mode without an email provider, and never honors the
 * local-development exemption.
 */
export function assertIdentityConfig(
  env: Pick<AuthEnv, "allowUnverifiedEmail"> & { hosted: boolean; hasEmail: boolean },
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
      `Signup mode "${policy.mode}" needs email delivery to verify new accounts. Configure SMTP_URL or EMAIL_API_URL, or set the signup mode to "closed".`,
    );
  }
}

type UserStatus = "pending" | "active" | "suspended";

function statusOf(user: object): UserStatus {
  const status = (user as { status?: unknown }).status;
  return status === "pending" || status === "suspended" ? status : "active";
}

export function createAuth(prisma: PrismaClient, env: AuthEnv) {
  // Mailbox proof is required whenever mail can be sent. Only a non-production process with no
  // provider and the explicit flag may skip it.
  const verifyEmail = Boolean(env.email);
  const unverifiedAllowed =
    !env.email && env.allowUnverifiedEmail === true && !isHostedDeployment(env);
  const sendCode = (email: string, otp: string, type: Parameters<typeof codeEmail>[2]) => {
    // Keep the response timing generic. Production providers track and retry the promise,
    // while the composition root drains accepted delivery during graceful shutdown.
    void env.email?.send(codeEmail(email, otp, type)).catch((error) => env.onEmailError?.(error));
  };
  return betterAuth({
    appName: "Nova",
    secret: env.secret,
    baseURL: env.baseURL,
    trustedOrigins: buildTrustedOrigins(env),
    database: prismaAdapter(prisma, { provider: "postgresql" }),
    socialProviders: socialProviders(env.social),
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
        if (ctx.path === "/sign-up/email" && !env.email && !unverifiedAllowed) {
          throw new APIError("BAD_REQUEST", {
            message: "Email delivery is not configured. Ask your administrator to set it up.",
          });
        }
        if (
          ctx.path === "/email-otp/send-verification-otp" &&
          ctx.body?.type === "sign-in" &&
          typeof ctx.body.email === "string"
        ) {
          // Do not mail a code to an address that could never get an account.
          const existing = await ctx.context.internalAdapter.findUserByEmail(ctx.body.email);
          if (!existing) {
            const admission = admitSignup(await resolveSignupPolicy(prisma, env), ctx.body.email, {
              firstAccount: true,
            });
            if (!admission.ok) throw new APIError("BAD_REQUEST", { message: admission.message });
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
                  if (!session.user.emailVerified && !unverifiedAllowed) return null;
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
            if (statusOf(user) === "suspended") {
              throw new APIError("FORBIDDEN", { message: "Account suspended" });
            }
            if (!user.emailVerified && !unverifiedAllowed) {
              throw new APIError("FORBIDDEN", { message: "Email verification required" });
            }
            // A pending account may sign in to see its waiting screen, but gets no space,
            // Computer or model access until an admin approves it.
            if (statusOf(user) === "pending") return;
            const membership = await prisma.spaceMember.findFirst({ where: { userId: user.id } });
            if (!membership) {
              const admission = admitSignup(await resolveSignupPolicy(prisma, env), user.email, {
                firstAccount: true,
              });
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
            // One choke point for every way in: password, email code, Google, Microsoft.
            const [policy, settings] = await Promise.all([
              resolveSignupPolicy(prisma, env),
              prisma.deploymentSettings.findUnique({
                where: { id: "default" },
                select: { ownerUserId: true },
              }),
            ]);
            const admission = admitSignup(policy, user.email, {
              firstAccount: !settings?.ownerUserId,
            });
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
